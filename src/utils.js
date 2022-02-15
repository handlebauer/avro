/* eslint-disable consistent-return */
function hasDuplicates(arr, fn) {
  const obj = {}
  let elem
  for (let i = 0, l = arr.length; i < l; i++) {
    elem = arr[i]
    if (fn) {
      elem = fn(elem)
    }
    if (obj[elem]) {
      return true
    }
    obj[elem] = true
  }
  return false
}

/**
 * A tap is a buffer which remembers what has been already read.
 *
 * It is optimized for performance, at the cost of failing silently when
 * overflowing the buffer. This is a purposeful trade-off given the expected
 * rarity of this case and the large performance hit necessary to enforce
 * validity. See `isValid` below for more information.
 *
 */
function Tap(buf, pos) {
  this.buf = buf
  this.pos = pos | 0
}

/**
 * Check that the tap is in a valid state.
 *
 * For efficiency reasons, none of the methods below will fail if an overflow
 * occurs (either read, skip, or write). For this reason, it is up to the
 * caller to always check that the read, skip, or write was valid by calling
 * this method.
 *
 */
Tap.prototype.isValid = function () {
  return this.pos <= this.buf.length
}

Tap.prototype.readInt = Tap.prototype.readLong = function () {
  let n = 0
  let k = 0
  const buf = this.buf
  let b, h, f, fk

  do {
    b = buf[this.pos++]
    h = b & 0x80
    n |= (b & 0x7f) << k
    k += 7
  } while (h && k < 28)

  if (h) {
    // Switch to float arithmetic, otherwise we might overflow.
    f = n
    fk = 268435456 // 2 ** 28.
    do {
      b = buf[this.pos++]
      f += (b & 0x7f) * fk
      fk *= 128
    } while (b & 0x80)
    return (f % 2 ? -(f + 1) : f) / 2
  }

  return (n >> 1) ^ -(n & 1)
}

Tap.prototype.writeInt = Tap.prototype.writeLong = function (n) {
  const buf = this.buf
  let f, m

  if (n >= -1073741824 && n < 1073741824) {
    // Won't overflow, we can use integer arithmetic.
    m = n >= 0 ? n << 1 : (~n << 1) | 1
    do {
      buf[this.pos] = m & 0x7f
      m >>= 7
    } while (m && (buf[this.pos++] |= 0x80))
  } else {
    // We have to use slower floating arithmetic.
    f = n >= 0 ? n * 2 : -n * 2 - 1
    do {
      buf[this.pos] = f & 0x7f
      f /= 128
    } while (f >= 1 && (buf[this.pos++] |= 0x80))
  }
  this.pos++
}

Tap.prototype.readString = function () {
  const len = this.readLong()
  const pos = this.pos
  const buf = this.buf
  this.pos += len
  if (this.pos > buf.length) {
    return
  }
  const u8 = new Uint8Array(this.buf).slice(pos, pos + len)
  return new TextDecoder().decode(u8)
}

Tap.prototype.writeString = function (s) {
  const buf = new TextEncoder().encode(s)
  const len = buf.byteLength
  this.writeLong(len)
  const pos = this.pos
  this.pos += len
  if (this.pos > this.buf.length) {
    return
  }
  this.buf.set(buf, pos)
}

export { hasDuplicates, Tap }
