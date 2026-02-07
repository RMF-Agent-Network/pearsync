import Corestore from 'corestore'
import Autobase from 'autobase'
import Hyperbee from 'hyperbee'
import Hyperblobs from 'hyperblobs'
import RAM from 'random-access-memory'
import b4a from 'b4a'
import tmp from 'tmp-promise'

class TestSetup {
  constructor () {
    this.stores = []
    this.bases = []
    this.cleanup = []
  }

  async createStore () {
    const dir = await tmp.dir({ unsafeCleanup: true })
    this.cleanup.push(() => dir.cleanup())
    const store = new Corestore(dir.path)
    this.stores.push(store)
    await store.ready()
    return store
  }

  async createAutobase (store, bootstrap = null) {
    const base = new Autobase(store, bootstrap, {
      open: this._openFunction.bind(this),
      apply: this._applyFunction.bind(this),
      valueEncoding: 'json'
    })

    this.bases.push(base)
    await base.ready()
    return base
  }

  _openFunction (store) {
    return store.get('view', { valueEncoding: 'binary' })
  }

  async createBlobStore (store) {
    const core = store.get({ name: 'blobs' })
    const blobs = new Hyperblobs(core)
    await blobs.ready()
    return blobs
  }

  _applyFunction (batch, view, base) {
    const bee = new Hyperbee(view, {
      keyEncoding: 'utf-8',
      valueEncoding: 'json'
    })

    return new Promise((resolve, reject) => {
      const ops = []

      for (const node of batch) {
        const op = node.value
        if (!op) continue

        if (op.type === 'put') {
          ops.push(bee.put(op.key, op.value))
        } else if (op.type === 'del') {
          ops.push(bee.del(op.key))
        } else if (op.type === 'add-writer') {
          const key = typeof writerKey === 'string' ? b4a.from(op.writerKey, 'hex') : op.writerKey
          ops.push(base.addWriter(key))
        } else if (op.type === 'remove-writer') {
          const key = typeof op.writerKey === 'string' ? b4a.from(op.writerKey, 'hex') : op.writerKey
          const nodeWriterKey = b4a.toString(node.writer.key, 'hex')
          const targetKey = b4a.toString(key, 'hex')
          if (nodeWriterKey === targetKey) {
            ops.push(base.removeWriter(key))
          }
        }
      }

      Promise.all(ops).then(() => resolve()).catch(reject)
    })
  }

  async createView (base) {
    const bee = new Hyperbee(base.view, {
      keyEncoding: 'utf-8',
      valueEncoding: 'json'
    })
    await bee.ready()
    return bee
  }

  async destroy () {
    for (const base of this.bases) {
      await base.close()
    }
    for (const store of this.stores) {
      await store.close()
    }
    for (const fn of this.cleanup) {
      await fn()
    }
  }
}

export { TestSetup }
