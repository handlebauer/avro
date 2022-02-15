import test from 'ava'

import { parse } from './src/index.js'

const tagParser = parse({
  type: 'record',
  name: 'Tag',
  fields: [
    { name: 'name', type: 'string' },
    { name: 'value', type: 'string' },
  ],
})

test.before(t => {
  t.context.tagsParser = parse({
    type: 'array',
    items: tagParser,
  })
  t.context.tags = [
    { name: 'App-Name', value: 'BUIDL' },
    { name: 'App-Version', value: '0.0.0' },
  ]
})

test('A parsed schema should encode an object to a Uint8Array', t => {
  const { tagsParser, tags } = t.context

  const encoded = tagsParser.toBuffer(tags)

  t.true(encoded instanceof Uint8Array)
})

test('A parsed schema should decode a buffer to an object', t => {
  const { tagsParser, tags } = t.context

  const encoded = tagsParser.toBuffer(tags)
  const decoded = tagsParser.fromBuffer(encoded)

  t.true(decoded instanceof Object)
})

test('A parsed schema should decode an encoded object back to the same value', t => {
  const { tagsParser, tags } = t.context

  const encoded = tagsParser.toBuffer(tags)
  const decoded = tagsParser.fromBuffer(encoded)

  t.true(
    tags.every(
      ({ name, value }, i) =>
        name === decoded[i].name && value === decoded[i].value
    )
  )
})

test('A parse schema should detect when an invalid object is supplied', t => {
  const { tagsParser } = t.context

  const invalidTags = [{ name: 'Invalid', value: true }]

  t.false(tagsParser.isValid(invalidTags))
})
