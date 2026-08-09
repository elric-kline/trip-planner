import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  typedRoutes: true,
  experimental: {
    serverActions: {
      // Next's own default is 1 MB, well under a real phone-camera JPEG --
      // the passport photo upload (see lib/passport.ts's own 8 MB cap) is
      // the one Server Action in this app that actually needs headroom.
      // Below Next's own limit, an oversized request never reaches the
      // action at all: no server log, no thrown RuleError, nothing --
      // it just looks like the button did nothing, which is exactly the
      // failure this was set too low to avoid. Set comfortably above
      // MAX_PHOTO_BYTES to leave room for multipart overhead and the
      // form's other fields.
      bodySizeLimit: "10mb",
    },
  },
};

export default nextConfig;
