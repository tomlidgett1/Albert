import type { Metadata } from "next";
import { ImessageManager } from "./ImessageManager";

export const metadata: Metadata = {
  title: "iMessage · Albert",
  description: "Text Albert. Answers from your live business data.",
};

export default function ImessagePage() {
  return <ImessageManager />;
}
