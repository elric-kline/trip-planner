import { ImageResponse } from "next/og";

// No border radius here — iOS applies its own rounded-square mask to
// touch icons, so a pre-rounded source produces double corners.
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0f766e",
          color: "white",
          fontSize: 104,
          fontWeight: 700,
          fontFamily: "sans-serif",
        }}
      >
        A
      </div>
    ),
    { ...size },
  );
}
