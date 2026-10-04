export const IMAGE_SERVICE = Object.freeze({
  provider: "qizhi",
  providerName: "奇智 API",
  baseUrl: "https://api.qizhi.cc",
  registrationUrl: "https://api.qizhi.cc/sign-up?aff=Vwf1",
  defaultModel: "qizhi-image-g-v2.5-lowprice",
  maxImages: 15,
  maxImageBytes: 50 * 1024 * 1024,
  maxPromptLength: 5000,
});

export const IMAGE_SIZES = Object.freeze([
  "auto", "1:1", "1:3", "3:1", "16:9", "9:16", "4:3", "3:4",
  "3:2", "2:3", "5:4", "4:5", "2:1", "1:2", "21:9", "9:21",
]);
export const IMAGE_RESOLUTIONS = Object.freeze(["1k", "2k", "4k"]);
export const IMAGE_MODES = Object.freeze(["generate", "clarity", "single-frame", "ai-edit"]);
export const ACTIVE_IMAGE_STATUSES = Object.freeze([
  "queued", "uploading", "submitting", "pending", "downloading",
]);

export function sameOrderedValues(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((value, index) => value === right[index]);
}

export function imageUploadConsentMatches(consent, inputIds, imageUrls) {
  return consent?.provider === IMAGE_SERVICE.provider
    && sameOrderedValues(consent.inputIds, inputIds)
    && sameOrderedValues(consent.imageUrls, imageUrls);
}

export function normalizeProviderStatus(value) {
  const normalized = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (["SUCCESS", "SUCCEEDED", "COMPLETED"].includes(normalized)) return "completed";
  if (["FAILURE", "FAILED", "ERROR", "CANCELLED", "CANCELED"].includes(normalized)) return "failed";
  if (["NOT_START", "SUBMITTED", "IN_PROGRESS", "QUEUED", "PENDING", "RUNNING", "PROCESSING"].includes(normalized)) return "pending";
  return "unknown";
}
