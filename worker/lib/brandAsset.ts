
import type { AppBindings } from "../env";

/**
 * R2 is disabled in this deployment.
 * Keep brand images in their original form:
 * - Existing URLs remain unchanged.
 * - Base64 data URLs remain inline.
 * - No image is uploaded or migrated to R2.
 */
export async function normalizeBrandImage(
  _env: AppBindings,
  _kind: "logo" | "og",
  value: unknown,
): Promise<string> {
  if (typeof value !== "string") return "";
  return value;
}

/**
 * R2 migration is disabled.
 * Existing inline brand images remain stored in settings.
 */
export async function migrateBrandImages(
  _env: AppBindings,
  _db: unknown,
  _schema: unknown,
  _map: Record<string, unknown>,
): Promise<void> {
  // Intentionally no-op: R2 is not configured.
}
