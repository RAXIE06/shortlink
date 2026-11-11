
import { getDbHandle } from "../db";
import type { AppBindings } from "../env";
import { DEFAULT_APP_NAME, DEFAULT_BRAND_COLOR } from "@shared/defaults";
import {
  appNameFrom,
  brandColorFrom,
  descriptionFrom,
  getAllSettings,
  indexableFrom,
  logoFrom,
  ogImageFrom,
  twitterHandleFrom,
} from "./settings";

const KEY = "seo:v4";

// In-isolate memo so repeated HTML loads on a warm isolate don't pay a KV read
// each; tiny TTL keeps branding edits near-live. Doubles as the stale fallback.
let memo: { bundle: SeoBundle; until: number } | null = null;
const MEMO_MS = 30_000;

function defaultBundle(env: AppBindings): SeoBundle {
  return {
    appName: DEFAULT_APP_NAME,
    description: "",
    brandColor: DEFAULT_BRAND_COLOR,
    logo: "",
    ogImage: "",
    indexable: true,
    appUrl: env.APP_URL,
    twitterHandle: "",
  };
}

interface SeoBundle {
  appName: string;
  description: string;
  brandColor: string;
  logo: string;
  ogImage: string;
  indexable: boolean;
  appUrl: string;
  twitterHandle: string;
}

/** Cached in KV so the per-request HTML injection rarely touches the DB. */
export async function getSeoBundle(env: AppBindings): Promise<SeoBundle> {
  const now = Date.now();
  if (memo && memo.until > now) return memo.bundle;

  try {
    const cached = await env.LINKS_KV.get<SeoBundle>(KEY, "json");
    if (cached) {
      memo = { bundle: cached, until: now + MEMO_MS };
      return cached;
    }
  } catch {
    // KV unavailable / over read quota → fall back to DB.
  }

  try {
    const { db, schema, close } = getDbHandle(env);
    try {
      const map = await getAllSettings(db, schema);

      // Keep brand images in their original form.
      // No R2 migration or upload is performed.
      const bundle: SeoBundle = {
        appName: appNameFrom(map),
        description: descriptionFrom(map),
        brandColor: brandColorFrom(map),
        logo: logoFrom(map),
        ogImage: ogImageFrom(map) || logoFrom(map),
        indexable: indexableFrom(map),
        appUrl: env.APP_URL,
        twitterHandle: twitterHandleFrom(map),
      };

      await env.LINKS_KV.put(KEY, JSON.stringify(bundle), {
        expirationTtl: 3600,
      }).catch(() => {});

      memo = { bundle, until: now + MEMO_MS };
      return bundle;
    } finally {
      await close().catch(() => {});
    }
  } catch {
    return memo?.bundle ?? defaultBundle(env);
  }
}

export async function invalidateSeo(kv: KVNamespace): Promise<void> {
  memo = null;
  await kv.delete(KEY);
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Rewrite the SPA shell <head> with current branding + SEO metadata. */
export function injectSeo(html: Response, b: SeoBundle, path = "/"): Response {
  const title = b.appName;
  const desc = b.description || `${b.appName} — a fast, clean URL shortener.`;
  const origin = b.appUrl.replace(/\/+$/, "");
  const canonical = origin + (path === "/" ? "" : path);

  const favicon = b.logo
    ? b.logo.startsWith("http")
      ? b.logo
      : "/icon"
    : "/favicon.svg";

  const hasOg = b.ogImage.length > 0;
  const ogImageUrl = hasOg
    ? b.ogImage.startsWith("http")
      ? b.ogImage
      : `${origin}/og`
    : "";

  const ld: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: title,
    url: origin,
  };

  if (desc) ld.description = desc;

  const ldLogo = b.logo
    ? b.logo.startsWith("http")
      ? b.logo
      : `${origin}/icon`
    : "";

  if (ldLogo) {
    ld.publisher = {
      "@type": "Organization",
      name: title,
      logo: ldLogo,
    };
  }

  const ldJson = JSON.stringify(ld).replace(/</g, "\\u003c");

  let head = `
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${esc(title)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(canonical)}">
<meta name="twitter:card" content="${hasOg ? "summary_large_image" : "summary"}">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">`;

  if (hasOg) {
    head += `\n<meta property="og:image" content="${esc(ogImageUrl)}">\n<meta property="og:image:alt" content="${esc(title)}">\n<meta name="twitter:image" content="${esc(ogImageUrl)}">`;
  }

  if (b.twitterHandle) {
    head += `\n<meta name="twitter:site" content="${esc(b.twitterHandle)}">`;
  }

  head += `\n<script type="application/ld+json">${ldJson}</script>`;

  if (!b.indexable) {
    head += `\n<meta name="robots" content="noindex,nofollow">`;
  }

  return new HTMLRewriter()
    .on("title", {
      element(el) {
        el.setInnerContent(title);
      },
    })
    .on('meta[name="description"]', {
      element(el) {
        el.setAttribute("content", desc);
      },
    })
    .on('meta[name="theme-color"]', {
      element(el) {
        el.setAttribute("content", b.brandColor);
      },
    })
    .on('link[rel="icon"]', {
      element(el) {
        el.setAttribute("href", favicon);
      },
    })
    .on("head", {
      element(el) {
        el.append(head, { html: true });
      },
    })
    .transform(html);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);

  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }

  return bytes;
}

/** Serve the favicon (/icon) or OG image (/og) from settings. */
export async function serveBrandImage(
  env: AppBindings,
  which: "icon" | "og",
): Promise<Response> {
  const b = await getSeoBundle(env);
  const src = which === "og" ? b.ogImage : b.logo;

  if (!src) {
    return new Response("Not found", { status: 404 });
  }

  if (src.startsWith("http")) {
    return Response.redirect(src, 302);
  }

  // R2 is disabled. Only inline base64 images are supported here.
  const m = /^data:([^;]+);base64,(.+)$/.exec(src);

  if (!m) {
    return new Response("Not found", { status: 404 });
  }

  try {
    return new Response(base64ToBytes(m[2]), {
      headers: {
        "content-type": m[1],
        "cache-control": "public, max-age=3600",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return new Response("Invalid image", { status: 400 });
  }
}

export async function robotsTxt(env: AppBindings): Promise<string> {
  const b = await getSeoBundle(env);

  if (!b.indexable) {
    return "User-agent: *\nDisallow: /\n";
  }

  const origin = b.appUrl.replace(/\/+$/, "");

  return (
    "User-agent: *\n" +
    "Disallow: /api/\n" +
    "Disallow: /dashboard\n" +
    "Disallow: /admin\n" +
    "Disallow: /account\n" +
    `Sitemap: ${origin}/sitemap.xml\n`
  );
}

/** A minimal sitemap of the public, indexable pages. */
export async function sitemapXml(env: AppBindings): Promise<string> {
  const b = await getSeoBundle(env);
  const origin = b.appUrl.replace(/\/+$/, "");

  const paths = b.indexable
    ? ["/", "/login", "/register", "/terms", "/privacy"]
    : [];

  const urls = paths
    .map((p) => `  <url><loc>${esc(origin + p)}</loc></url>`)
    .join("\n");

  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    (urls ? urls + "\n" : "") +
    "</urlset>\n"
  );
}
