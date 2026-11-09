type Fn = () => void | Promise<void>;
const tests: { name: string; fn: Fn }[] = [];

export function test(name: string, fn: Fn): void {
  tests.push({ name, fn });
}

export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

export async function runAll(): Promise<void> {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`✓ ${t.name}`);
    } catch (e) {
      failed++;
      console.log(`✗ ${t.name}\n    ${(e as Error).message}`);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  if (failed) process.exit(1);
}
