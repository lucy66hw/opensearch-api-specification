/*
* Copyright OpenSearch Contributors
* SPDX-License-Identifier: Apache-2.0
*
* The OpenSearch Contributors require contributions made to
* this file be licensed under the Apache-2.0 license or a
* compatible open source license.
*/

import { Command, Option } from '@commander-js/extra-typings';
import { read_yaml, write_yaml } from '../helpers';
import Filter from './Filter';
import { Sanitizer } from './Sanitizer';
import { Logger, LogLevel } from '../Logger'
import path, {resolve} from 'path';

let config_filtered_path: string[] | undefined;
try {
  const config = read_yaml(path.join(__dirname, 'filter_path.yaml'));
  config_filtered_path = config.paths;
} catch (e) {
  console.error(e);
  config_filtered_path = undefined;
}
const default_api_to_proto = config_filtered_path ?? ['/_search'];
const default_api_to_proto_str = default_api_to_proto.join(',');
console.log(default_api_to_proto_str)
const command = new Command()
  .description('Preprocess an OpenAPI spec by filtering for specific paths and then sanitizing it.')
  .addOption(new Option('-i, --input <path>', 'input YAML file').default((resolve(__dirname, '../../../build/opensearch-openapi.yaml'))))
  .addOption(new Option('-o, --output <path>', 'output YAML file').default((resolve(__dirname, '../../../build/processed-opensearch-openapi.yaml'))))
  .addOption(
    new Option('-p, --filtered_path <paths>', 'the paths to keep (comma-separated, e.g., /_search,)')
      .argParser((val: string) => val.split(',').map(s => s.trim()))
      .default(default_api_to_proto)
  )
  .addOption(new Option('--verbose', 'show merge details').default(false))
  .allowExcessArguments(false)
  .parse();


type PreprocessingOpts = {
  input: string;
  output: string;
  filtered_path: string[];
  verbose: boolean;
};

const opts = command.opts() as PreprocessingOpts;

const logger = new Logger(opts.verbose ? LogLevel.info : LogLevel.warn)
const filter = new Filter(logger);
const sanitizer = new Sanitizer();
try {
  logger.log(`Preprocessing ${opts.filtered_path.join(', ')} into ${opts.output} ...`)
  const original_spec = read_yaml(opts.input);
  const filtered_spec = filter.filter_spec(original_spec, opts.filtered_path);
  const sanitized_spec = sanitizer.sanitize_spec(filtered_spec);
  write_yaml(opts.output, sanitized_spec);

} catch (err) {
  console.error('Error in preprocessing:', err);
  process.exit(1);
}
logger.log('Done.')