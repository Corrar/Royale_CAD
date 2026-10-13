// Permanent guard: the kernel project sees no DOM and no Node types, so both
// directives below must stay errors. If a lib leaks in, a directive becomes
// unused and `tsc -b` fails.
// @ts-expect-error DOM must not be visible to the kernel
export type DomLeak = HTMLElement
// @ts-expect-error Node must not be visible to the kernel
export type NodeLeak = NodeJS.Process
