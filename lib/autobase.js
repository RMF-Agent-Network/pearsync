import Autobase from 'autobase'
import Hyperbee from 'hyperbee'
import Hyperblobs from 'hyperblobs'
import b4a from 'b4a'

class PearSyncAutobase {
  constructor (store, blobs, bootstrap = null) {
    this.store = store
    this.blobs = blobs
    this.base = null
    this.localWriter = null
    this.bootstrap = bootstrap
    this._ready = false
  }

  async ready () {
    if (this._ready) return

    const bootstrap = this.bootstrap ? this.bootstrap[0] : null

    this.base = new Autobase(this.store, bootstrap, {
      open: this._open.bind(this),
      apply: this._applyBatch.bind(this),
      valueEncoding: 'json'
    })

    await this.base.ready()
    this.localWriter = this.base.local.key

    this._ready = true
  }

  _open (store) {
    return store.get('view', { valueEncoding: 'binary' })
  }

  async _applyBatch (batch, view, base) {
    const bee = new Hyperbee(view, {
      keyEncoding: 'utf-8',
      valueEncoding: 'json'
    })

    const ops = []

    for (const node of batch) {
      const op = node.value
      if (!op) continue

      if (op.type === 'put') {
        ops.push(bee.put(op.key, op.value))
      } else if (op.type === 'del') {
        ops.push(bee.del(op.key))
      } else if (op.type === 'add-writer') {
        const key = b4a.from(op.writerKey, 'hex')
        ops.push(base.addWriter(key))
      } else if (op.type === 'remove-writer') {
        const key = b4a.from(op.writerKey, 'hex')
        const nodeWriterKey = b4a.toString(node.writer.key, 'hex')
        const targetKey = b4a.toString(key, 'hex')
        if (nodeWriterKey === targetKey) {
          ops.push(base.removeWriter(key))
        }
      }
    }

    await Promise.all(ops)
  }

  async append (op) {
    await this.base.append(op)
  }

  async addWriter (writerKey) {
    const key = typeof writerKey === 'string' ? b4a.from(writerKey, 'hex') : writerKey
    const input = this.store.get(key)
    await input.ready()
    this.base.activeWriters.add(input)
    await this.base.view.update()
  }

  async removeWriter (writerKey) {
    const key = typeof writerKey === 'string' ? b4a.from(writerKey, 'hex') : writerKey
    const isSelf = b4a.toString(key, 'hex') === b4a.toString(this.localWriter, 'hex')

    if (isSelf) {
      const keyHex = b4a.toString(key, 'hex')
      for (const [k, writer] of this.base.activeWriters.map) {
        if (k === keyHex) {
          this.base.activeWriters.delete(writer.core)
          break
        }
      }
      await this.base.view.update()
    }
  }

  async putBlob (content) {
    const descriptor = await this.blobs.put(content)
    return descriptor
  }

  async getBlob (descriptor) {
    return await this.blobs.get(descriptor)
  }

  async list () {
    const bee = new Hyperbee(this.base.view, {
      keyEncoding: 'utf-8',
      valueEncoding: 'json'
    })

    const entries = []
    for await (const entry of bee.createReadStream()) {
      entries.push(entry)
    }
    return entries
  }

  async close () {
    await this.base.close()
  }
}

export { PearSyncAutobase }
