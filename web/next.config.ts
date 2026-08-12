import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  turbopack: {
    root: path.join(__dirname, ".."),
  },
  experimental: {
    // proxy.ts sees the multipart request before the Server Action does.
    // Its separate 10 MB default would truncate larger valid PDFs and cause
    // "Unexpected end of form", so it needs the same multipart headroom.
    proxyClientMaxBodySize: "21mb",
    serverActions: {
      // The backend accepts files up to 20 MiB. The extra 1 MiB leaves room
      // for multipart boundaries, part headers, and the optional title field.
      bodySizeLimit: "21mb",
    },
  },
};

export default nextConfig;
