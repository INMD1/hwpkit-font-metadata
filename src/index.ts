export {
  analyzeFontSource,
  analyzeFontSources,
  createCatalog,
} from "./analyze.js";
export type { AnalyzeOptions, AnalyzeError, FontProfile } from "./analyze.js";
export {
  checkCoverageCompatibility,
  compareFontProfiles,
  compareProfiles,
  computeFormatAdjustments,
  rankCandidates,
  rankFontCandidates,
} from "./compare.js";
export type {
  ComparisonOptions,
  CompareResult,
  CoverageCheckResult,
  FormatAdjustments,
  RankResult,
} from "./compare.js";
export {
  detectFontContainer,
  discoverFontFiles,
  isSupportedFontFile,
  loadFontFiles,
  loadFontSources,
  SUPPORTED_FONT_EXTENSIONS,
} from "./font-source.js";
export type {
  DiscoverResult,
  FaceDescriptor,
  FontErrorRecord,
  FontFileInfo,
  FontSource,
  LoadResult,
} from "./font-source.js";
export {
  CATALOG_SCHEMA_ID,
  COMPARISON_SCHEMA_ID,
  CORPUS_ID,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  PROFILE_SCHEMA_ID,
  SCHEMA_VERSION,
} from "./constants.js";
