import type { Metadata } from "next";
import LoginForm from "./login-form";

export const metadata: Metadata = {
  title: "Sign in · Albert",
  description: "Sign in or create your Albert account.",
};

export default async function LoginPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const query = await searchParams;
  return <LoginForm authError={typeof query.auth_error === "string"} />;
}
