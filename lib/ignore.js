import ignore from 'ignore'
import fs from 'fs/promises'

class IgnoreParser {
  constructor (ignoreFilePath = null) {
    this.ignoreFilePath = ignoreFilePath
    this.ig = ignore()
    this._loaded = false
  }

  async load () {
    if (this._loaded) return

    // Add default patterns
    this.ig.add([
      '.git/',
      'node_modules/',
      '.DS_Store',
      'Thumbs.db'
    ])

    // Load custom patterns from .pearsyncignore if provided
    if (this.ignoreFilePath) {
      try {
        const content = await fs.readFile(this.ignoreFilePath, 'utf-8')
        const lines = content
          .split('\n')
          .map(line => line.trim())
          .filter(line => line && !line.startsWith('#'))

        this.ig.add(lines)
      } catch (err) {
        if (err.code !== 'ENOENT') {
          throw err
        }
        // File doesn't exist, use only default patterns
      }
    }

    this._loaded = true
  }

  ignores (filePath) {
    if (!this._loaded) {
      throw new Error('IgnoreParser not loaded. Call load() first.')
    }

    return this.ig.ignores(filePath)
  }
}

export { IgnoreParser }
