/*
* Copyright OpenSearch Contributors
* SPDX-License-Identifier: Apache-2.0
*
* The OpenSearch Contributors require contributions made to
* this file be licensed under the Apache-2.0 license or a
* compatible open source license.
*/

import { type ActualResponse, type Payload } from './types/story.types'
import { type ChapterEvaluation, type Evaluation, Result, EvaluationWithOutput } from './types/eval.types'
import { type ParsedOperation } from './types/spec.types'
import { overall_result } from './helpers'
import type ChapterReader from './ChapterReader'
import type OperationLocator from './OperationLocator'
import type SchemaValidator from './SchemaValidator'
import { type StoryOutputs } from './StoryOutputs'
import { ChapterOutput } from './ChapterOutput'
import _ from 'lodash'
import { Logger } from 'Logger'
import { sleep, to_json } from '../helpers'
import { APPLICATION_JSON } from "./MimeTypes"
import { ParsedChapter } from './types/parsed_story.types'
import ResponsePayloadEvaluator from './ResponsePayloadEvaluator'

export default class ChapterEvaluator {
  private readonly logger: Logger
  private readonly _operation_locator: OperationLocator
  private readonly _chapter_reader: ChapterReader
  private readonly _schema_validator: SchemaValidator

  constructor(spec_parser: OperationLocator, chapter_reader: ChapterReader, schema_validator: SchemaValidator, logger: Logger) {
    this._operation_locator = spec_parser
    this._chapter_reader = chapter_reader
    this._schema_validator = schema_validator
    this.logger = logger
  }

  async evaluate(chapter: ParsedChapter, skip: boolean, story_outputs: StoryOutputs): Promise<ChapterEvaluation> {
    if (skip) return { title: chapter.synopsis, overall: { result: Result.SKIPPED } }

    const operation = this._operation_locator.locate_operation(chapter)
    if (operation == null) return { title: chapter.synopsis, overall: { result: Result.FAILED, message: `Operation "${chapter.method.toUpperCase()} ${chapter.path}" not found in the spec.` } }

    var tries = chapter.retry && chapter.retry?.count > 0 ? chapter.retry.count + 1 : 1
    var retry = 0

    var result: ChapterEvaluation

    do {
      result = await this.#evaluate(chapter, operation, story_outputs, ++retry > 1 ? retry - 1 : undefined)

      if (result.overall.result === Result.PASSED || result.overall.result === Result.SKIPPED) {
        return result
      }

      if (--tries == 0) break
      this.logger.info(`Failed, retrying, ${tries == 1 ? '1 retry left' : `${tries} retries left`} ...`)
      await sleep(chapter.retry?.wait ?? 1000)
    } while (tries > 0)

    return result
  }

  async #evaluate(chapter: ParsedChapter, operation: ParsedOperation, story_outputs: StoryOutputs, retries?: number): Promise<ChapterEvaluation> {
    const response = await this._chapter_reader.read(chapter, story_outputs)
    const params = this.#evaluate_parameters(chapter, operation, story_outputs)
    const request = this.#evaluate_request(chapter, operation, story_outputs)
    const status = this.#evaluate_status(chapter, response)
    const payload_schema_evaluation = status.result === Result.PASSED ? this.#evaluate_payload_schema(chapter, response, operation) : { result: Result.SKIPPED }
    const output_values_evaluation: EvaluationWithOutput = status.result === Result.PASSED ? ChapterOutput.extract_output_values(response, chapter.output) : { evaluation: { result: Result.SKIPPED } }
    const response_payload: Payload | undefined = status.result === Result.PASSED ? story_outputs.resolve_value(chapter.response?.payload) : chapter.response?.payload
    const payload_body_evaluation = status.result === Result.PASSED ? new ResponsePayloadEvaluator(this.logger).evaluate(response, response_payload) : { result: Result.SKIPPED }

    if (output_values_evaluation.output) this.logger.info(`$ ${to_json(output_values_evaluation.output)}`)

    const evaluations = _.compact(_.concat(
      Object.values(params),
      request,
      status,
      payload_body_evaluation,
      payload_schema_evaluation,
      output_values_evaluation.evaluation
    ))

    var result: ChapterEvaluation = {
      title: chapter.synopsis,
      operation: {
        method: chapter.method,
        path: chapter.path
      },
      path: `${chapter.method} ${chapter.path}`,
      overall: { result: overall_result(evaluations) },
      request: { parameters: params, request },
      response: {
        status,
        payload_body: payload_body_evaluation,
        payload_schema: payload_schema_evaluation,
        output_values: output_values_evaluation.evaluation
      }
    }

    if (retries !== undefined) {
      result.retries = retries
    }

    if (output_values_evaluation?.output !== undefined) {
      result.output = output_values_evaluation?.output
    }

    return result
  }

  #evaluate_parameters(chapter: ParsedChapter, operation: ParsedOperation, story_outputs: StoryOutputs): Record<string, Evaluation> {
    const parameters: Record<string, any> = story_outputs.resolve_value(chapter.parameters) ?? {}
    return Object.fromEntries(Object.entries(parameters).map(([name, parameter]) => {
      const schema = operation.parameters[name]?.schema
      if (schema == null) return [name, { result: Result.FAILED, message: `Schema for "${name}" parameter not found.` }]
      const evaluation = this._schema_validator.validate(schema, parameter)
      return [name, evaluation]
    }))
  }

  #evaluate_request(chapter: ParsedChapter, operation: ParsedOperation, story_outputs: StoryOutputs): Evaluation {
    if (chapter.request?.payload === undefined) return { result: Result.PASSED }
    const content_type = chapter.request.content_type ?? APPLICATION_JSON
    const schema = operation.requestBody?.content[content_type]?.schema
    if (schema == null) return { result: Result.FAILED, message: `Schema for "${content_type}" request body not found in the spec.` }
    const payload = story_outputs.resolve_value(chapter.request?.payload) ?? {}
    return this._schema_validator.validate(schema, payload)
  }

  #evaluate_status(chapter: ParsedChapter, response: ActualResponse): Evaluation {
    const expected_status = chapter.response?.status ?? 200

    const is_status_match = Array.isArray(expected_status)
      ? expected_status.includes(response.status)
      : response.status === expected_status

    if (is_status_match && response.error === undefined) return { result: Result.PASSED }

    let result: Evaluation = {
      result: Result.ERROR,
      message: _.join(_.compact([
        is_status_match ?
          `Received ${response.status ?? 'none'}: ${response.content_type ?? 'unknown'}.` :
          `Expected status ${Array.isArray(expected_status) ? expected_status.join(' or ') : expected_status}, but received ${response.status ?? 'none'}: ${response.content_type ?? 'unknown'}.`,
        response.message
      ]), ' ')
    }

    if (response.error !== undefined) {
      result.error = response.error as Error
    }

    return result
  }

  #evaluate_payload_schema(chapter: ParsedChapter, response: ActualResponse, operation: ParsedOperation): Evaluation {
    const content_type = chapter.response?.content_type ?? APPLICATION_JSON

    if (response.content_type !== content_type) {
      return {
        result: Result.FAILED,
        message: `Expected content type ${content_type}, but received ${response.content_type}.`
      }
    }

    const content = operation.responses[response.status]?.content?.[content_type]

    if (content == null) {
      return {
        result: Result.FAILED,
        message: `Schema for "${response.status}: ${content_type}" response not found in the spec.`
      }
    }

    if (content.schema == null) return { result: Result.PASSED }

    return this._schema_validator.validate(content.schema, response.payload)
  }
}
