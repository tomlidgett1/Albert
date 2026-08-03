import ResetPasswordForm from "./reset-password-form";

export default async function ResetPasswordPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const query = await searchParams;
  return <ResetPasswordForm updateMode={query.mode === "update"} />;
}
