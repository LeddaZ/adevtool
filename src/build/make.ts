import { basename } from 'path'
import { BlobEntry } from '../blobs/entry'
import { PartitionProps } from '../blobs/props'
import { SelinuxPartResolutions } from '../sepolicy/contexts'
import { MAKEFILE_HEADER } from '../util/headers'

const CONT_SEPARATOR = ' \\\n    '

const SEPOLICY_PARTITION_VARS: { [part: string]: string } = {
  system: 'BOARD_PLAT_PUBLIC_SEPOLICY_DIR',
  system_ext: 'SYSTEM_EXT_PUBLIC_SEPOLICY_DIRS',
  product: 'PRODUCT_PUBLIC_SEPOLICY_DIRS',
  vendor: 'BOARD_VENDOR_SEPOLICY_DIRS',
  odm: 'BOARD_ODM_SEPOLICY_DIRS',
}

export interface Symlink {
  moduleName: string
  linkPartition: string
  linkSubpath: string
  targetPath: string
}

export interface ModulesMakefile {
  device: string
  vendor: string

  radioFiles?: Array<string>

  symlinks: Array<Symlink>
}

export interface ProductMakefile {
  namespaces?: Array<string>
  copyFiles?: Array<string>
  packages?: Array<string>

  props?: PartitionProps
  fingerprint?: string
}

export interface BoardMakefile {
  abOtaPartitions?: Array<string>
  boardInfo?: string
  secontextResolutions?: SelinuxPartResolutions
}

function startBlocks() {
  return [MAKEFILE_HEADER]
}

function finishBlocks(blocks: Array<string>) {
  return blocks.join('\n\n') + '\n'
}

export function sanitizeBasename(path: string) {
  return basename(path).replaceAll(/[^a-z0-9_\-.]/g, '_')
}

function partPathToMakePath(partition: string, subpath: string) {
  let copyPart = partition == 'system' ? 'PRODUCT_OUT' : `TARGET_COPY_OUT_${partition.toUpperCase()}`
  return `$(${copyPart})/${subpath}`
}

export function blobToFileCopy(entry: BlobEntry, proprietaryDir: string) {
  let destPath = partPathToMakePath(entry.partition, entry.path)
  return `${proprietaryDir}/${entry.srcPath}:${destPath}`
}

export function serializeModulesMakefile(mk: ModulesMakefile) {
  let blocks = startBlocks()
  blocks.push(
    'LOCAL_PATH := $(call my-dir)',
    `ifeq ($(TARGET_DEVICE),${mk.device})`,
  )

  if (mk.radioFiles != undefined) {
    blocks.push(mk.radioFiles.map(img => `$(call add-radio-file,${img})`).join('\n'))
  }

  for (let link of mk.symlinks) {
    let destPath = partPathToMakePath(link.linkPartition, link.linkSubpath)

    blocks.push(`include $(CLEAR_VARS)
LOCAL_MODULE := ${link.moduleName}
LOCAL_MODULE_CLASS := FAKE
LOCAL_MODULE_TAGS := optional
LOCAL_MODULE_OWNER := ${mk.vendor}
include $(BUILD_SYSTEM)/base_rules.mk
$(LOCAL_BUILT_MODULE): TARGET := ${link.targetPath}
$(LOCAL_BUILT_MODULE): SYMLINK := ${destPath}
$(LOCAL_BUILT_MODULE):
\t$(hide) mkdir -p $(dir $@)
\t$(hide) mkdir -p $(dir $(SYMLINK))
\t$(hide) rm -rf $@
\t$(hide) rm -rf $(SYMLINK)
\t$(hide) ln -sf $(TARGET) $(SYMLINK)
\t$(hide) touch $@`)
  }

  blocks.push('endif')
  return finishBlocks(blocks)
}

function addContBlock(blocks: Array<string>, variable: String, items: Array<string> | undefined) {
  if (items != undefined) {
    blocks.push(`${variable} += \\
    ${items.join(CONT_SEPARATOR)}`)
  }
}

export function serializeProductMakefile(mk: ProductMakefile) {
  let blocks = startBlocks()

  addContBlock(blocks, 'PRODUCT_SOONG_NAMESPACES', mk.namespaces)
  addContBlock(blocks, 'PRODUCT_COPY_FILES', mk.copyFiles)
  addContBlock(blocks, 'PRODUCT_PACKAGES', mk.packages)

  if (mk.props != undefined) {
    for (let [partition, props] of mk.props.entries()) {
      if (props.size == 0) {
        continue
      }

      let propLines = Array.from(props.entries()).map(([k, v]) => `${k}=${v}`)

      blocks.push(`PRODUCT_${partition.toUpperCase()}_PROPERTIES += \\
    ${propLines.join(CONT_SEPARATOR)}`)
    }
  }

  if (mk.fingerprint != undefined) {
    blocks.push(`PRODUCT_OVERRIDE_FINGERPRINT := ${mk.fingerprint}`)
  }

  return finishBlocks(blocks)
}

export function serializeBoardMakefile(mk: BoardMakefile) {
  let blocks = startBlocks()

  // TODO: remove when all ELF prebuilts work with Soong
  blocks.push('BUILD_BROKEN_ELF_PREBUILT_PRODUCT_COPY_FILES := true')

  // Build vendor?
  if (mk.abOtaPartitions?.includes('vendor')) {
    blocks.push('BOARD_VENDORIMAGE_FILE_SYSTEM_TYPE := ext4')
  }

  addContBlock(blocks, 'AB_OTA_PARTITIONS', mk.abOtaPartitions)

  if (mk.boardInfo != undefined) {
    blocks.push(`TARGET_BOARD_INFO_FILE := ${mk.boardInfo}`)
  }

  if (mk.secontextResolutions != undefined) {
    for (let [partition, {sepolicyDirs, missingContexts}] of mk.secontextResolutions.entries()) {
      let partVar = SEPOLICY_PARTITION_VARS[partition]
      if (sepolicyDirs.length > 0) {
        addContBlock(blocks, partVar, sepolicyDirs)
      }

      if (missingContexts.length > 0) {
        blocks.push(missingContexts.map(c => `# Missing ${partition} SELinux context: ${c}`)
          .join('\n'))
      }
    }
  }

  return finishBlocks(blocks)
}
