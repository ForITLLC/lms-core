import type { Config } from "tailwindcss";
import typography from "@tailwindcss/typography";
import { themePreset } from "./lib/theme";
import foritPreset from "./tailwind/preset";

const config: Config = {
  presets: [foritPreset, themePreset],
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  plugins: [typography],
};

export default config;
