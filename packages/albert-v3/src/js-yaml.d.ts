declare module "js-yaml" {
  export function load(
    value: string,
    options?: Readonly<Record<string, unknown>>,
  ): unknown;

  export function dump(
    value: unknown,
    options?: Readonly<Record<string, unknown>>,
  ): string;
}
