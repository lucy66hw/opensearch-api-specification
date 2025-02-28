/*
* Copyright OpenSearch Contributors
* SPDX-License-Identifier: Apache-2.0
*
* The OpenSearch Contributors require contributions made to
* this file be licensed under the Apache-2.0 license or a
* compatible open source license.
*/

import _ from "lodash";
import { OpenAPIV3 } from "openapi-types";

/**
 * Sanitizer class:
 * Provides a static method to sanitize a spec by updating $ref strings
 * and renaming schema definitions.
 */
export class Sanitizer {
  public sanitize_spec(spec: OpenAPIV3.Document): any {
    if (spec.paths != null) {
      this.sanitize_fields(spec.paths, false);
    }
    if (spec.components) {
      this.sanitize_components(spec.components);
    }
    return spec;
  }

  sanitize_components(components: OpenAPIV3.ComponentsObject): void {
    if (components.schemas) {
      this.sanitize_fields(components.schemas, true);
    }
    if (components.parameters) {
      this.sanitize_fields(components.parameters, false);
    }
    if (components.requestBodies) {
      this.sanitize_fields(components.requestBodies, false);
    }
    if (components.responses) {
      this.sanitize_fields(components.responses, false);
    }
  }

  sanitize_fields(obj: any, need_rename: boolean): void {
    for (const key in obj) {
      var item = obj[key]

      if (item?.$ref !== undefined) {
        var renamed_ref = this.rename_ref(item.$ref as string)
        if (renamed_ref != item.$ref) {
          item.$ref = renamed_ref
        }
      }

      var renamed_key = this.rename_model_name(key, need_rename)
      if (renamed_key != key) {
        obj[renamed_key] = obj[key]
        delete obj[key]
      }

      if (_.isObject(item) || _.isArray(item)) {
        this.sanitize_fields(item, need_rename)
      }
    }
  }

  rename_model_name(schema_name: string, need_model_rename: boolean): string {
    if (schema_name.includes('___') && need_model_rename) {
      return schema_name.split('___').pop() as string;
    }
    return schema_name;
  }

  rename_ref(ref: string): string {
    if (typeof ref === 'string' && ref.startsWith('#/components/schemas')) {
      const ref_parts = ref.split('/');
      if (ref_parts.length === 4) {
        const old_model_name = ref_parts[3];
        const new_model_name = this.rename_model_name(old_model_name, true);
        return ref_parts.slice(0, 3).join('/') + '/' + new_model_name;
      }
    }

    return ref;
  }
}
