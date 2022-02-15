import { createType } from './schemas.js'

/**
 * Parse a schema and return the corresponding type.
 */
export const parse = (schema, opts) => createType(schema, opts)
