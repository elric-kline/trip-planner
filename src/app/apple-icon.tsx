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
          background: "#c24a2a",
        }}
      >
        {/* The AgreeMobile mark: a map pin with a checkmark — a stop, agreed on. */}
        <svg width="112" height="112" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <path
            d="M12 2C7.58 2 4 5.58 4 10c0 5.25 6.72 11.19 7.31 11.71a1 1 0 0 0 1.38 0C13.28 21.19 20 15.25 20 10c0-4.42-3.58-8-8-8Z"
            fill="#ffffff"
          />
          <path
            d="M8.5 10.4 10.8 12.7 15.1 8.1"
            stroke="#c24a2a"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </svg>
      </div>
    ),
    { ...size },
  );
}
