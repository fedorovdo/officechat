/** @type {import('next').NextConfig} */
const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL?.trim();
const websocketUrl = backendUrl?.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
const backendSources = backendUrl ? ` ${backendUrl} ${websocketUrl}` : "";

const nextConfig = {
  output: "standalone",
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          {
            key: "Content-Security-Policy",
            value: `default-src 'self'; connect-src 'self'${backendSources}; img-src 'self' data: blob:${backendUrl ? ` ${backendUrl}` : ""}; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; frame-ancestors 'none';`
          }
        ]
      }
    ];
  }
};

export default nextConfig;
