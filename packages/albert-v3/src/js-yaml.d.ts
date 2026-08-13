declare module "js-yaml" {
  export function dump(
    value: unknown,
    options?: Readonly<Record<string, unknown>>,
  ): string;
}
