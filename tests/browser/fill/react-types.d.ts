// Minimal ambient types for the two React entry points the fill tests use. @types/react would be a
// new dependency for a handful of calls (react and react-dom are test-only, ADR 0024).
declare module "react" {
  export function createElement(
    type: string | ((props: never) => unknown),
    props?: Record<string, unknown> | null,
    ...children: unknown[]
  ): unknown;
  export function useState<T>(initial: T): [T, (value: T) => void];
}

declare module "react-dom/client" {
  export interface Root {
    render(node: unknown): void;
    unmount(): void;
  }
  export function createRoot(container: Element): Root;
}
