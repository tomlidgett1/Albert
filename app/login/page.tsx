import type { Metadata } from "next";
import LoginForm from "./login-form";

export const metadata: Metadata = {
  title: "Sign in · Albert",
  description: "Sign in or create your Albert account.",
};

export default function LoginPage() {
  return <LoginForm />;
}
