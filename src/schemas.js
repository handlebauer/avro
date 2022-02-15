import { hasDuplicates, Tap } from './utils.js'

// Convenience imports.

function throwInvalidError(path, val, type) {
  throw new Error(`invalid ${type}: ${val}`)
}

// Valid (field, type, and symbol) name regex.
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

const TAP = new Tap(new Uint8Array(1024))

// Path prefix for validity checks (shared for performance).
const PATH = []

/**
 * Schema parsing entry point.
 *
 * It isn't exposed directly but called from `parse` inside `index.js` (node)
 * or `avro.js` (browserify) which each add convenience functionality.
 *
 **/
function createType(attrs, opts) {
  if (attrs instanceof Type) {
    return attrs
  }

  opts = getOpts(attrs, opts)

  let type
  if (typeof attrs == 'string') {
    type = opts.registry[attrs]
    if (type) {
      return type
    }
    if (isPrimitive(attrs)) {
      type = opts.registry[attrs] = createType({ type: attrs }, opts)
      return type
    }
    throw new Error(`undefined type name: ${attrs}`)
  }

  // New type definition.
  type = (function (typeName) {
    const Type = TYPES[typeName]
    if (Type === undefined) {
      throw new Error(`unknown type: ${typeName}`)
    }
    return new Type(attrs, opts)
  })(attrs.type)

  return type
}

/**
 * "Abstract" base Avro type class.
 *
 * This class' constructor will register any named types to support
 * recursive schemas.
 *
 * All type values are represented in memory similarly to their JSON
 * representation, except for `bytes` and `fixed` which are represented as
 * `Buffer`s. See individual subclasses for details.
 *
 */
class Type {
  constructor(registry) {
    const name = this._name
    const type = this

    if (registry === undefined || name === undefined) {
      return
    }

    const prev = registry[name]
    if (prev !== undefined) {
      throw new Error(`duplicate type name: ${name}`, name)
    }
    registry[name] = type
  }
  fromBuffer(buf, resolver, noCheck) {
    const tap = new Tap(buf)
    const val = readValue(this, tap, resolver, noCheck)
    if (!tap.isValid()) {
      throw new Error('truncated buffer')
    }
    if (!noCheck && tap.pos < buf.length) {
      throw new Error('trailing data')
    }
    return val
  }
  toBuffer(val) {
    TAP.pos = 0
    this._write(TAP, val)
    if (!TAP.isValid()) {
      Type._reset(2 * TAP.pos)
      TAP.pos = 0
      this._write(TAP, val)
    }
    // OLD
    // const buf = Buffer.alloc(TAP.pos)
    // TAP.buf.copy(buf, 0, 0, TAP.pos)
    // return buf
    // NEW
    return Uint8Array.from(TAP.buf.slice(0, TAP.pos))
  }
  fromString(str) {
    return this._copy(JSON.parse(str), { coerce: 2 })
  }
  toString(val) {
    if (val === undefined) {
      // Consistent behavior with standard `toString` expectations.
      return this.getSchema(true)
    }
    return JSON.stringify(this._copy(val, { coerce: 3 }))
  }
  isValid(val, opts) {
    while (PATH.length) {
      // In case the previous `isValid` call didn't complete successfully (e.g.
      // if an exception was thrown, but then caught in client code), `PATH`
      // might be non-empty, we must manually clear it.
      PATH.pop()
    }
    return this._check(val, opts && opts.errorHook)
  }
}

// Implementations.

/**
 * Base primitive Avro type.
 *
 * Most of the primitive types share the same cloning and resolution
 * mechanisms, provided by this class. This class also lets us conveniently
 * check whether a type is a primitive using `instanceof`.
 *
 */
class PrimitiveType extends Type {}

/**
 * Strings.
 *
 */
class StringType extends PrimitiveType {
  _check(val, cb) {
    const b = typeof val == 'string'
    if (!b && cb) {
      cb(PATH.slice(), val, this)
    }
    return b
  }
  _read(tap) {
    const result = tap.readString()
    return result
  }
  _skip(tap) {
    tap.skipString()
  }
  _write(tap, val) {
    if (typeof val != 'string') {
      throwInvalidError(null, val, this)
    }
    tap.writeString(val)
  }
  _match(tap1, tap2) {
    return tap1.matchString(tap2)
  }
}

/**
 * Avro array.
 *
 * Represented as vanilla arrays.
 *
 */
class ArrayType extends Type {
  constructor(attrs, opts) {
    super()

    if (!attrs.items) {
      throw new Error(`missing array items: ${attrs}`)
    }

    opts = getOpts(attrs, opts)

    this._items = createType(attrs.items, opts)
  }

  _check(val, cb) {
    if (!(val instanceof Array)) {
      if (cb) {
        cb(PATH.slice(), val, this)
      }
      return false
    }

    const b = true
    let j
    if (cb) {
      // Slow path.
      j = PATH.length
      PATH.push('')
      for (let i = 0, l = val.length; i < l; i++) {
        PATH[j] = '' + i
        if (!this._items._check(val[i], cb)) {
          b = false
        }
      }
      PATH.pop()
    } else {
      for (let i = 0, l = val.length; i < l; i++) {
        if (!this._items._check(val[i], cb)) {
          return false
        }
      }
    }
    return b
  }
  _read(tap) {
    const items = this._items
    const val = []
    let n
    while ((n = tap.readLong())) {
      if (n < 0) {
        n = -n
        tap.skipLong() // Skip size.
      }
      while (n--) {
        val.push(items._read(tap))
      }
    }
    return val
  }
  _write(tap, val) {
    if (!(val instanceof Array)) {
      throwInvalidError(null, val, this)
    }

    const n = val.length
    if (n) {
      tap.writeLong(n)
      for (let i = 0; i < n; i++) {
        this._items._write(tap, val[i])
      }
    }
    tap.writeLong(0)
  }
}

/**
 * Avro record.
 *
 * Values are represented as instances of a programmatically generated
 * constructor (similar to a "specific record"), available via the
 * `getRecordConstructor` method. This "specific record class" gives
 * significant speedups over using generics objects.
 *
 * Note that vanilla objects are still accepted as valid as long as their
 * fields match (this makes it much more convenient to do simple things like
 * update nested records).
 *
 */
class RecordType extends Type {
  constructor(attrs, opts) {
    super()

    opts = getOpts(attrs, opts)

    const resolutions = resolveNames(attrs, opts.namespace)
    this._name = resolutions.name
    this._aliases = resolutions.aliases
    this._type = attrs.type

    if (!(attrs.fields instanceof Array)) {
      throw new Error(`non-array ${this._name} fields`)
    }
    this._fields = attrs.fields.map(f => {
      return new Field(f, opts)
    })
    if (
      hasDuplicates(attrs.fields, f => {
        return f.name
      })
    ) {
      throw new Error(`duplicate ${this._name} field name`)
    }

    const isError = attrs.type === 'error'
    this._constructor = this._createConstructor(isError)
    this._read = this._createReader()
    this._skip = this._createSkipper()
    this._write = this._createWriter()
    this._check = this._createChecker()
  }

  _createConstructor(isError) {
    // jshint -W054
    const outerArgs = []
    const innerArgs = []
    const ds = [] // Defaults.
    let innerBody = isError ? '  Error.call(this);\n' : ''
    // Not calling `Error.captureStackTrace` because this wouldn't be compatible
    // with browsers other than Chrome.
    let field, name, getDefault
    for (let i = 0, l = this._fields.length; i < l; i++) {
      field = this._fields[i]
      getDefault = field.getDefault
      name = field._name
      innerArgs.push('v' + i)
      innerBody += '  '
      if (getDefault() === undefined) {
        innerBody += 'this.' + name + ' = v' + i + ';\n'
      } else {
        innerBody += 'if (v' + i + ' === undefined) { '
        innerBody += 'this.' + name + ' = d' + ds.length + '(); '
        innerBody += '} else { this.' + name + ' = v' + i + '; }\n'
        outerArgs.push('d' + ds.length)
        ds.push(getDefault)
      }
    }
    let outerBody = 'return function ' + unqualify(this._name) + '('
    outerBody += innerArgs.join() + ') {\n' + innerBody + '};'
    const Record = new Function(outerArgs.join(), outerBody).apply(
      undefined,
      ds
    )

    const self = this
    Record.getType = function () {
      return self
    }
    Record.prototype = {
      constructor: Record,
      $clone(opts) {
        return self.clone(this, opts)
      },
      $compare(val) {
        return self.compare(this, val)
      },
      $getType: Record.getType,
      $isValid(opts) {
        return self.isValid(this, opts)
      },
      $toBuffer() {
        return self.toBuffer(this)
      },
      $toString(noCheck) {
        return self.toString(this, noCheck)
      },
    }
    // The names of these properties added to the prototype are prefixed with `$`
    // because it is an invalid property name in Avro but not in JavaScript.
    // (This way we are guaranteed not to be stepped over!)
    return Record
  }
  _createChecker() {
    // jshint -W054
    const names = ['t', 'P']
    const values = [this, PATH]
    let body = 'return function check' + unqualify(this._name) + '(val, cb) {\n'
    body += "  if (val === null || typeof val != 'object') {\n"
    body += '    if (cb) { cb(P.slice(), val, t); }\n'
    body += '    return false;\n'
    body += '  }\n'
    if (!this._fields.length) {
      // Special case, empty record. We handle this directly.
      body += '  return true;\n'
    } else {
      let field
      for (let i = 0, l = this._fields.length; i < l; i++) {
        field = this._fields[i]
        names.push('t' + i)
        values.push(field._type)
        if (field.getDefault() !== undefined) {
          body += '  const v' + i + ' = val.' + field._name + ';\n'
        }
      }
      body += '  if (cb) {\n'
      body += '    const b = 1;\n'
      body += '    const j = P.length;\n'
      body += "    P.push('');\n"
      for (let i = 0, l = this._fields.length; i < l; i++) {
        field = this._fields[i]
        body += "    P[j] = '" + field._name + "';\n"
        if (field.getDefault() === undefined) {
          body += '    b &= t' + i + '._check(val.' + field._name + ', cb);\n'
        } else {
          body += '    b &= v' + i + ' === undefined || '
          body += 't' + i + '._check(v' + i + ', cb);\n'
        }
      }
      body += '    P.pop();\n'
      body += '    return !!b;\n'
      body += '  } else {\n    return (\n      '
      body += this._fields
        .map((field, i) => {
          if (field.getDefault() === undefined) {
            return 't' + i + '._check(val.' + field._name + ')'
          }
          return '(v' + i + ' === undefined || t' + i + '._check(v' + i + '))'
        })
        .join(' &&\n      ')
      body += '\n    );\n  }\n'
    }
    body += '};'
    return new Function(names.join(), body).apply(undefined, values)
  }

  _createReader() {
    const uname = unqualify(this._name)
    const names = []
    const values = [this._constructor]
    for (let i = 0, l = this._fields.length; i < l; i++) {
      names.push('t' + i)
      values.push(this._fields[i]._type)
    }
    let body = 'return function read' + uname + '(tap) {\n'
    body += '  return new ' + uname + '('
    body += names
      .map(t => {
        return t + '._read(tap)'
      })
      .join()
    body += ');\n};'
    names.unshift(uname)
    // We can do this since the JS spec guarantees that function arguments are
    // evaluated from left to right.
    return new Function(names.join(), body).apply(undefined, values)
  }
  _createSkipper() {
    // jshint -W054
    const args = []
    let body = 'return function skip' + unqualify(this._name) + '(tap) {\n'
    const values = []

    for (let i = 0, l = this._fields.length; i < l; i++) {
      args.push('t' + i)
      values.push(this._fields[i]._type)
      body += '  t' + i + '._skip(tap);\n'
    }
    body += '}'
    return new Function(args.join(), body).apply(undefined, values)
  }
  _createWriter() {
    // jshint -W054
    // We still do default handling here, in case a normal JS object is passed.
    const args = []
    let body =
      'return function write' + unqualify(this._name) + '(tap, val) {\n'
    const values = []
    let field, value
    for (let i = 0, l = this._fields.length; i < l; i++) {
      field = this._fields[i]
      args.push('t' + i)
      values.push(field._type)
      body += '  '
      if (field.getDefault() === undefined) {
        body += 't' + i + '._write(tap, val.' + field._name + ');\n'
      } else {
        value = field._type.toBuffer(field.getDefault()).toString('binary')
        // Convert the default value to a binary string ahead of time. We aren't
        // converting it to a buffer to avoid retaining too much memory. If we
        // had our own buffer pool, this could be an idea in the future.
        args.push('d' + i)
        values.push(value)
        body += 'const v' + i + ' = val.' + field._name + '; '
        body += 'if (v' + i + ' === undefined) { '
        body += 'tap.writeBinary(d' + i + ', ' + value.length + ');'
        body += ' } else { t' + i + '._write(tap, v' + i + '); }\n'
      }
    }
    body += '}'
    return new Function(args.join(), body).apply(undefined, values)
  }
}

// General helpers.

/**
 * Field.
 *
 * @param attrs {Object} The field's schema.
 * @para opts {Object} Schema parsing options (the same as `Type`s').
 *
 */
class Field {
  constructor(attrs, opts) {
    const name = attrs.name
    if (typeof name != 'string' || !NAME_PATTERN.test(name)) {
      throw new Error(`invalid field name: ${name}`)
    }

    this._name = name
    this._type = createType(attrs.type, opts)
    this._aliases = attrs.aliases || []

    this._order = (function (order) {
      switch (order) {
        case 'ascending':
          return 1
        case 'descending':
          return -1
        case 'ignore':
          return 0
        default:
          throw new Error(`invalid order: ${order}`)
      }
    })(attrs.order === undefined ? 'ascending' : attrs.order)
  }
  getDefault() {}
}

/**
 * Read a value from a tap.
 *
 * @param type {Type} The type to decode.
 * @param tap {Tap} The tap to read from. No checks are performed here.
 * @param resolver {Resolver} Optional resolver. It must match the input type.
 * @param lazy {Boolean} Skip trailing fields when using a resolver.
 *
 */
function readValue(type, tap, resolver, lazy) {
  if (resolver) {
    if (resolver._readerType !== type) {
      throw new Error('invalid resolver')
    }
    return resolver._read(tap, lazy)
  }
  return type._read(tap)
}

/**
 * Create default parsing options.
 *
 * @param attrs {Object} Schema to populate options with.
 * @param opts {Object} Base options.
 *
 */
function getOpts(attrs, opts) {
  if (attrs === null) {
    // Let's be helpful for this common error.
    throw new Error('invalid type: null (did you mean "null"?)')
  }
  opts = opts || {}
  opts.registry = opts.registry || {}
  opts.namespace = attrs.namespace || opts.namespace
  opts.logicalTypes = opts.logicalTypes || {}
  return opts
}

/**
 * Resolve a schema's name and aliases.
 *
 * @param attrs {Object} True schema (can't be a string).
 * @param namespace {String} Optional parent namespace.
 * @param key {String} Key where the name should be looked up (defaults to
 * `name`).
 *
 */
function resolveNames(attrs, namespace, key) {
  namespace = attrs.namespace || namespace
  key = key || 'name'

  const name = attrs[key]
  if (!name) {
    throw new Error(`missing ${key} property in schema: ${attrs}`)
  }
  return {
    name: qualify(name),
    aliases: attrs.aliases ? attrs.aliases.map(qualify) : [],
  }

  function qualify(name) {
    if (!~name.indexOf('.') && namespace) {
      name = namespace + '.' + name
    }
    const tail = unqualify(name)
    if (isPrimitive(tail)) {
      // Primitive types cannot be defined in any namespace.
      throw new Error(`cannot rename primitive type: ${tail}`)
    }
    name.split('.').forEach(part => {
      if (!NAME_PATTERN.test(part)) {
        throw new Error(`invalid name: ${name}`)
      }
    })
    return name
  }
}

/**
 * Remove namespace from a name.
 *
 * @param name {String} Full or short name.
 *
 */
function unqualify(name) {
  const parts = name.split('.')
  return parts[parts.length - 1]
}

/**
 * Check whether a type's name is a primitive.
 *
 * @param name {String} Type name (e.g. `'string'`, `'array'`).
 *
 */
function isPrimitive(name) {
  const type = TYPES[name]
  return type !== undefined && type.prototype instanceof PrimitiveType
}

// All Avro types.
const TYPES = {
  array: ArrayType,
  record: RecordType,
  string: StringType,
}

export { createType, resolveNames }
