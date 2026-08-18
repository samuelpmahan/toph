// Tests intentionally treat viewer API responses as loosely-typed JSON (this is a diagnostic
// endpoint layer, not a typed client); this tiny helper avoids sprinkling `as any` everywhere.
export async function json(res: Response): Promise<any> {
  return res.json();
}
