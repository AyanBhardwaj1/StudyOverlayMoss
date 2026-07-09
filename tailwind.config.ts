import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      boxShadow: {
        overlay: "0 24px 70px rgba(0, 0, 0, 0.42)",
      },
    },
  },
  plugins: [],
};

export default config;
