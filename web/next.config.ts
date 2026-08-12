import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  turbopack: {
    root: path.join(__dirname, ".."),
  },
  experimental: {
    serverActions: {
      // The backend accepts files up to 20 MiB. The extra 1 MiB leaves room
      // for multipart boundaries, part headers, and the optional title field.
      bodySizeLimit: "21mb",
    },
  },
};

export default nextConfig;
