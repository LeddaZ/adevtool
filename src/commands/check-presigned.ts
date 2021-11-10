import { Command, flags } from '@oclif/command'
import { promises as fs } from 'fs'
import * as chalk from 'chalk'

import { parseFileList } from '../blobs/file_list'
import { enumeratePresignedBlobs, parsePresignedRecursive, updatePresignedBlobs } from '../blobs/presigned'

export default class CheckPresigned extends Command {
  static description = 'check for APKs that should be presigned'

  static flags = {
    help: flags.help({char: 'h'}),
    aapt2: flags.string({char: 'a', description: 'path to aapt2 executable', default: 'out/host/linux-x86/bin/aapt2'}),
    sepolicy: flags.string({char: 'p', description: 'paths to device and vendor sepolicy dirs', required: true, multiple: true}),
  }

  static args = [
    {name: 'source', description: 'path to mounted factory images', required: true},
    {name: 'listPath', description: 'path to LineageOS-compatible proprietary-files.txt list'},
  ]

  async run() {
    let {flags: {aapt2: aapt2Path, sepolicy: sepolicyDirs}, args: {source, listPath}} = this.parse(CheckPresigned)

    // Parse list
    this.log(chalk.bold(chalk.greenBright('Parsing list')))
    let list = listPath != null ? await fs.readFile(listPath, {encoding: 'utf8'}) : null
    let entries = list != null ? parseFileList(list) : null

    // Find and parse sepolicy seapp_contexts
    let presignedPkgs = await parsePresignedRecursive(sepolicyDirs)

    if (entries != null) {
      // Get APKs from blob entries
      let presignedEntries = await updatePresignedBlobs(aapt2Path, source, presignedPkgs, entries)
      presignedEntries.forEach(e => this.log(e.srcPath))

      // TODO: write new list
    } else {
      // Find APKs
      let presignedPaths = await enumeratePresignedBlobs(aapt2Path, source, presignedPkgs)
      presignedPaths.forEach(p => this.log(p))
    }
  }
}
