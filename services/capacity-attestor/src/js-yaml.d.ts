declare module "js-yaml" {
  export function load(source: string, options?: Readonly<Record<string, unknown>>): unknown;
}
