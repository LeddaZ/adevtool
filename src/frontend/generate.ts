import { promises as fs } from 'fs'
import ora from 'ora'
import path from 'path'
import { flattenAllApexs } from '../blobs/apex'

import { generateBuild, VendorDirectories, writeBuildFiles } from '../blobs/build'
import { BlobEntry } from '../blobs/entry'
import { combinedPartPathToEntry, diffLists, listPart, serializeBlobList } from '../blobs/file-list'
import { diffPartOverlays, parsePartOverlayApks, serializePartOverlays } from '../blobs/overlays'
import { parsePresignedRecursive, updatePresignedBlobs } from '../blobs/presigned'
import { diffPartitionProps, loadPartitionProps, PartitionProps } from '../blobs/props'
import { diffPartVintfManifests, loadPartVintfInfo, writePartVintfManifests } from '../blobs/vintf'
import { findOverrideModules } from '../build/overrides'
import { parseModuleInfo, removeSelfModules } from '../build/soong-info'
import { DeviceConfig } from '../config/device'
import { filterKeys, Filters, filterValue, filterValues } from '../config/filters'
import { SystemState } from '../config/system-state'
import { ANDROID_INFO, extractFactoryFirmware, generateAndroidInfo, writeFirmwareImages } from '../images/firmware'
import { diffPartContexts, parseContextsRecursive, parsePartContexts, resolvePartContextDiffs, SelinuxContexts, SelinuxPartResolutions } from '../selinux/contexts'
import { generateFileContexts } from '../selinux/labels'
import { readFile, TempState } from '../util/fs'
import { ALL_SYS_PARTITIONS } from '../util/partitions'

export interface PropResults {
  stockProps: PartitionProps
  missingProps?: PartitionProps

  fingerprint?: string
  missingOtaParts: Array<string>
}

export async function enumerateFiles(
  spinner: ora.Ora,
  filters: Filters,
  forceIncludeFilters: Filters | null,
  namedEntries: Map<string, BlobEntry>,
  customState: SystemState | null,
  stockSrc: string,
  customSrc: string | null,
) {
  for (let partition of ALL_SYS_PARTITIONS) {
    let filesRef = await listPart(partition, stockSrc, filters)
    if (filesRef == null) continue
    let filesNew = customState != null ? customState.partitionFiles[partition] :
      (customSrc != null ? await listPart(partition, customSrc, filters) :
        [])
    if (filesNew == null) continue

    let missingFiles = diffLists(filesNew, filesRef)

    // Evaluate force-include filters and merge forced files from ref
    if (forceIncludeFilters != null) {
      let forcedFiles = filterValues(forceIncludeFilters, filesRef)
      missingFiles.push(...forcedFiles)
      // Re-sort
      missingFiles.sort((a, b) => a.localeCompare(b))
    }

    for (let combinedPartPath of missingFiles) {
      let entry = combinedPartPathToEntry(partition, combinedPartPath)
      namedEntries.set(combinedPartPath, entry)
    }

    spinner.text = partition
  }
}

export async function resolveOverrides(
  config: DeviceConfig,
  dirs: VendorDirectories,
  namedEntries: Map<string, BlobEntry>,
) {
  let targetPrefix = `out/target/product/${config.device.name}/`
  let targetPaths = Array.from(namedEntries.keys())
    .map(cPartPath => `${targetPrefix}${cPartPath}`)

  // TODO: switch to custom state
  let moduleInfoPath = `${targetPrefix}module-info.json`
  let modulesMap = parseModuleInfo(await readFile(moduleInfoPath))
  removeSelfModules(modulesMap, dirs.proprietary)
  let {modules: builtModules, builtPaths} = findOverrideModules(targetPaths, modulesMap)

  // Remove new modules from entries
  for (let path of builtPaths) {
    namedEntries.delete(path.replace(targetPrefix, ''))
  }

  return builtModules
}

export async function updatePresigned(
  spinner: ora.Ora,
  config: DeviceConfig,
  entries: BlobEntry[],
  aapt2Path: string,
  stockSrc: string,
) {
  let presignedPkgs = await parsePresignedRecursive(config.platform.sepolicy_dirs)
  await updatePresignedBlobs(aapt2Path, stockSrc, presignedPkgs, entries, entry => {
    spinner.text = entry.srcPath
  }, config.filters.presigned)
}

export async function flattenApexs(
  spinner: ora.Ora,
  entries: BlobEntry[],
  dirs: VendorDirectories,
  tmp: TempState,
  stockSrc: string,
) {
  let apex = await flattenAllApexs(entries, stockSrc, tmp, (progress) => {
    spinner.text = progress
  })

  // Write context labels
  let fileContexts = `${dirs.sepolicy}/file_contexts`
  await fs.writeFile(fileContexts, generateFileContexts(apex.labels))

  return apex.entries
}

export async function extractProps(
  config: DeviceConfig,
  customState: SystemState | null,
  stockSrc: string,
  customSrc: string | null,
) {
  let stockProps = await loadPartitionProps(stockSrc)
  let customProps = customState?.partitionProps ?? (customSrc != null ?
    await loadPartitionProps(customSrc) :
    new Map<string, Map<string, string>>())

  // Filters
  for (let props of stockProps.values()) {
    filterKeys(config.filters.props, props)
  }
  for (let props of customProps.values()) {
    filterKeys(config.filters.props, props)
  }

  // Fingerprint for SafetyNet
  let fingerprint = stockProps.get('system')!.get('ro.system.build.fingerprint')!

  // Diff
  let missingProps: PartitionProps | undefined = undefined
  if (customProps != null) {
    let propChanges = diffPartitionProps(stockProps, customProps)
    missingProps = new Map(Array.from(propChanges.entries())
      .map(([part, props]) => [part, props.removed]))
  }

  // A/B OTA partitions
  let stockOtaParts = stockProps.get('product')!.get('ro.product.ab_ota_partitions')!.split(',')
  let customOtaParts = new Set(customProps.get('product')?.get('ro.product.ab_ota_partitions')?.split(',') ?? [])
  let missingOtaParts = stockOtaParts.filter(p => !customOtaParts.has(p) &&
    filterValue(config.filters.partitions, p))

  return {
    stockProps,
    missingProps,

    fingerprint,
    missingOtaParts,
  } as PropResults
}

export async function resolveSepolicyDirs(
  config: DeviceConfig,
  customState: SystemState | null,
  dirs: VendorDirectories,
  stockSrc: string,
  customSrc: string,
) {
  // Built contexts
  let stockContexts = await parsePartContexts(stockSrc)
  let customContexts = customState?.partitionSecontexts ?? await parsePartContexts(customSrc)

  // Contexts from AOSP
  let sourceContexts: SelinuxContexts = new Map<string, string>()
  for (let dir of config.platform.sepolicy_dirs) {
    // TODO: support alternate ROM root
    let contexts = await parseContextsRecursive(dir, '.')
    for (let [ctx, source] of contexts.entries()) {
      sourceContexts.set(ctx, source)
    }
  }

  // Diff; reversed custom->stock order to get *missing* contexts
  let ctxDiffs = diffPartContexts(customContexts, stockContexts)
  let ctxResolutions = resolvePartContextDiffs(ctxDiffs, sourceContexts, config.filters.sepolicy_dirs)

  // Add APEX labels
  if (ctxResolutions.has('vendor')) {
    ctxResolutions.get('vendor')!.sepolicyDirs.push(dirs.sepolicy)
  }

  return ctxResolutions
}

export async function extractOverlays(
  spinner: ora.Ora,
  config: DeviceConfig,
  customState: SystemState | null,
  dirs: VendorDirectories,
  aapt2Path: string,
  stockSrc: string,
  customSrc: string,
) {
  let stockOverlays = await parsePartOverlayApks(aapt2Path, stockSrc, path => {
    spinner.text = path
  }, config.filters.overlay_files)

  let customOverlays = customState?.partitionOverlays ??
    await parsePartOverlayApks(aapt2Path, customSrc, path => {
      spinner.text = path
    }, config.filters.overlay_files)

  let missingOverlays = diffPartOverlays(stockOverlays, customOverlays, config.filters.overlays)
  return await serializePartOverlays(missingOverlays, dirs.overlays)
}

export async function extractVintfManifests(
  customState: SystemState | null,
  dirs: VendorDirectories,
  stockSrc: string,
  customSrc: string,
) {
  let customVintf = customState?.partitionVintfInfo ?? await loadPartVintfInfo(customSrc)
  let stockVintf = await loadPartVintfInfo(stockSrc)
  let missingHals = diffPartVintfManifests(customVintf, stockVintf)

  return await writePartVintfManifests(missingHals, dirs.vintf)
}

export async function extractFirmware(
  config: DeviceConfig,
  dirs: VendorDirectories,
  stockProps: PartitionProps,
  factoryZip: string,
) {
  let fwImages = await extractFactoryFirmware(factoryZip)
  let fwPaths = await writeFirmwareImages(fwImages, dirs.firmware)

  // Generate android-info.txt from device and versions
  let androidInfo = generateAndroidInfo(
    config.device.name,
    stockProps.get('vendor')!.get('ro.build.expect.bootloader')!,
    stockProps.get('vendor')!.get('ro.build.expect.baseband')!,
  )
  await fs.writeFile(`${dirs.firmware}/${ANDROID_INFO}`, androidInfo)

  return fwPaths
}

export async function generateBuildFiles(
  config: DeviceConfig,
  dirs: VendorDirectories,
  entries: BlobEntry[],
  buildPkgs: string[],
  propResults: PropResults | null,
  fwPaths: string[] | null,
  vintfManifestPaths: Map<string, string> | null,
  sepolicyResolutions: SelinuxPartResolutions | null,
  stockSrc: string,
  addAbOtaParts: boolean = true,
  enforceAllRros: boolean = false,
) {
  let build = await generateBuild(entries, config.device.name, config.device.vendor, stockSrc, dirs)

  // Add rules to build overridden modules and overlays, then re-sort
  build.deviceMakefile!.packages!.push(...buildPkgs)
  build.deviceMakefile!.packages!.sort((a, b) => a.localeCompare(b))

  // Add device parts
  build.deviceMakefile = {
    props: propResults?.missingProps,
    fingerprint: propResults?.fingerprint,
    ...(vintfManifestPaths != null && { vintfManifestPaths: vintfManifestPaths }),
    ...build.deviceMakefile,
  }

  // Add board parts
  build.boardMakefile = {
    ...(sepolicyResolutions != null && { sepolicyResolutions: sepolicyResolutions }),
    ...(propResults != null && propResults.missingOtaParts.length > 0 &&
      {
        buildPartitions: propResults.missingOtaParts,
        ...(addAbOtaParts && { abOtaPartitions: propResults.missingOtaParts }),
      }),
    ...(fwPaths != null && { boardInfo: `${dirs.firmware}/${ANDROID_INFO}` }),
  }

  // Enforce RROs?
  if (enforceAllRros) {
    build.deviceMakefile.enforceRros = '*'
  }

  // Add firmware
  if (fwPaths != null) {
    build.modulesMakefile!.radioFiles = fwPaths.map(p => path.relative(dirs.out, p))
  }

  // Create device
  if (config.generate.products) {
    if (propResults == null) {
      throw new Error('Product generation depends on properties')
    }

    let productProps = propResults.stockProps.get('product')!
    let productName = productProps.get('ro.product.product.name')!

    build.productMakefile = {
      baseProductPath: config.platform.product_makefile,
      name: productName,
      model: productProps.get('ro.product.product.model')!,
      brand: productProps.get('ro.product.product.brand')!,
      manufacturer: productProps.get('ro.product.product.manufacturer')!,
    }
    build.productsMakefile = {
      products: [productName],
    }
  }

  // Dump list
  let fileList = serializeBlobList(entries)
  await fs.writeFile(`${dirs.out}/proprietary-files.txt`, fileList + '\n')

  await writeBuildFiles(build, dirs)
}
