/**
 * Where a request value is still coerced instead of checked.
 *
 * Shared because all three repositories have routes and all three had this
 * bug; a sweep written once per repository is three things to keep right, and
 * the one that drifts is the one nobody is looking at. Each repository's own
 * test says which directories to read and asserts the answer is empty.
 *
 * `String(body.name ?? "")` hands a text column the words "[object Object]"
 * and refuses nothing — see `asText` in `./text-columns` for the whole of it.
 *
 * **It reads the code, not the spelling.** The first five versions were
 * regular expressions over lines, and they knew a request value by its name:
 * `body` or `payload`. Every value that arrived under another name walked
 * past all five — `const raw = await c.req.json()`, a `{ name, kind }` taken
 * straight out of one, a form's `form.get("alt")`, and a body handed whole to
 * a helper whose parameter was called `input` and then `raw`, which is how an
 * unknown timezone kept being saved as UTC with a 200. So the sweep now parses
 * each file and follows the value:
 *
 * - a name bound from `c.req.json()`, `c.req.formData()` or `c.req.parseBody()`
 *   — directly, destructured, or through `await`, `as`, `??` and `.catch()`;
 * - a name bound from one of those names, or from a field of one, in the
 *   scope where it was bound (so `const hours = raw.workingHours` is one too);
 * - `form.get("x")` on any of them;
 * - and a function's parameter, when a call in this repository passes one of
 *   those values in that position — the function found in the same file, by
 *   a relative import, or through a package of this repository's own, and
 *   followed until nothing new turns up.
 *
 * `body` and `payload` are still request values wherever they appear, which is
 * the convention the earlier sweeps enforced and nothing here relaxes.
 *
 * ponytail: not followed — a method call (`thing.save(body)`), a function
 * passed as a value, or a helper in another repository (a Pro route handing a
 * body to a Core function is swept by Core only if Core calls it the same way).
 * Query strings are left out on purpose: Hono hands them over as strings, so
 * none of the five shapes can be fooled by a list or an object there.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import ts from "typescript";

const SKIP = new Set(["node_modules", ".git", "dist", "drizzle", "build"]);

function sources(dir: string, found: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return found;
  }
  for (const name of entries) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, found);
    else if (/\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path))
      found.push(path);
  }
  return found;
}

export function sourcesUnder(repo: string, where: string[]): string[] {
  return where.flatMap((dir) => sources(join(repo, dir)));
}

type Shape = "text" | "number" | "choice" | "flag" | "shape";

/** Names a request value arrives under in every file, whatever bound them. */
const ALWAYS = new Set(["body", "payload"]);
const READS = new Set(["json", "formData", "parseBody"]);

/** What each package of the repository exports, by import specifier. */
function packagesOf(files: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const seen = new Set<string>();
  for (const file of files) {
    for (let dir = dirname(file); dir !== dirname(dir); dir = dirname(dir)) {
      if (seen.has(dir)) break;
      seen.add(dir);
      let manifest: { name?: string; exports?: unknown };
      try {
        manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      } catch {
        continue;
      }
      if (!manifest.name) break;
      const exports =
        typeof manifest.exports === "object" && manifest.exports !== null
          ? (manifest.exports as Record<string, unknown>)
          : {};
      for (const [key, target] of Object.entries(exports)) {
        if (typeof target !== "string" || !/\.tsx?$/.test(target)) continue;
        const spec = key === "." ? manifest.name : join(manifest.name, key);
        out.set(spec, join(dir, target));
      }
      break;
    }
  }
  return out;
}

function resolveModule(
  from: string,
  spec: string,
  parsed: Map<string, ts.SourceFile>,
  packages: Map<string, string>,
): string | null {
  if (!spec.startsWith(".")) return packages.get(spec) ?? null;
  const base = join(dirname(from), spec.replace(/\.js$/, ""));
  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    base,
  ]) {
    if (parsed.has(candidate)) return candidate;
  }
  return null;
}

/** Peel what does not change which value it is: parens, casts, await, a default. */
function peel(expression: ts.Expression): ts.Expression {
  let node = expression;
  for (;;) {
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isAwaitExpression(node)
    ) {
      node = node.expression;
    } else if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    ) {
      node = node.left;
    } else return node;
  }
}

function bindingNames(name: ts.BindingName, out: string[] = []): string[] {
  if (ts.isIdentifier(name)) out.push(name.text);
  else
    for (const element of name.elements) {
      if (!ts.isOmittedExpression(element)) bindingNames(element.name, out);
    }
  return out;
}

/** The name a function is called by, if it has one this sweep can follow. */
function functionName(node: ts.SignatureDeclaration): string | null {
  if (ts.isFunctionDeclaration(node)) return node.name?.text ?? null;
  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    ts.isVariableDeclaration(node.parent) &&
    ts.isIdentifier(node.parent.name)
  ) {
    return node.parent.name.text;
  }
  return null;
}

const WATCHED_FLAG_OPERATORS = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

/**
 * Where a coercion keeps nothing: words for an error message — `throw new
 * Error(\`"${String(value)}" is not a date\`)` refuses the request, which is
 * the point — and the inside of a function that only answers yes or no.
 */
function keepsNothing(node: ts.Node): boolean {
  for (let at = node.parent; at; at = at.parent) {
    if (ts.isFunctionLike(at)) return answersYesOrNo(at);
    if (ts.isThrowStatement(at)) return true;
    if (ts.isNewExpression(at) && /Error$/.test(at.expression.getText())) {
      return true;
    }
  }
  return false;
}

/**
 * A function that only answers yes or no — `isKind(x)`, `ownedAccount(id)` —
 * is not followed. What it is asked cannot be kept, only refused or accepted,
 * and whether a no becomes a refusal or a default is decided where it is
 * called: `isKind(body.kind) ? body.kind : "text"` is caught there.
 */
function answersYesOrNo(fn: ts.SignatureDeclaration): boolean {
  const said = fn.type?.getText() ?? "";
  if (fn.type && ts.isTypePredicateNode(fn.type)) return true;
  if (/^(boolean|Promise<boolean>)$/.test(said)) return true;
  if (!fn.type && ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) {
    const body = peel(fn.body);
    return (
      (ts.isBinaryExpression(body) &&
        [
          ts.SyntaxKind.AmpersandAmpersandToken,
          ts.SyntaxKind.EqualsEqualsEqualsToken,
          ts.SyntaxKind.ExclamationEqualsEqualsToken,
        ].includes(body.operatorToken.kind)) ||
      (ts.isPrefixUnaryExpression(body) &&
        body.operator === ts.SyntaxKind.ExclamationToken)
    );
  }
  return false;
}

interface Analysis {
  sites: Record<Shape, string[]>;
}

/**
 * Every place a request value is coerced, for one repository and one list of
 * directories. Worked out once and shared by the five questions below.
 */
const analyses = new Map<string, Analysis>();

function analyse(repo: string, where: string[]): Analysis {
  const key = `${repo}\0${where.join("\0")}`;
  const known = analyses.get(key);
  if (known) return known;

  const files = sourcesUnder(repo, where);
  const parsed = new Map<string, ts.SourceFile>();
  for (const file of files) {
    parsed.set(
      file,
      ts.createSourceFile(
        file,
        readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      ),
    );
  }
  const packages = packagesOf(files);
  const found: Record<Shape, string[]> = {
    text: [],
    number: [],
    choice: [],
    flag: [],
    shape: [],
  };
  /** `file#function` → the parameter positions a request value reaches. */
  const seeds = new Map<string, Set<number>>();

  /** Where `name`, as imported or declared in `file`, is defined. */
  function definitionOf(file: string, name: string, hops = 0): string | null {
    const sf = parsed.get(file);
    if (!sf || hops > 4) return null;
    let found: string | null | undefined;
    const declares = (node: ts.Node): void => {
      if (found !== undefined) return;
      const fn = ts.isFunctionDeclaration(node)
        ? node.name?.text === name
          ? node
          : undefined
        : ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.name.text === name &&
            node.initializer &&
            (ts.isArrowFunction(node.initializer) ||
              ts.isFunctionExpression(node.initializer))
          ? node.initializer
          : undefined;
      if (fn) {
        found = answersYesOrNo(fn) ? null : `${file}#${name}`;
        return;
      }
      ts.forEachChild(node, declares);
    };
    declares(sf);
    if (found !== undefined) return found;
    for (const statement of sf.statements) {
      if (
        !(
          ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)
        ) ||
        !statement.moduleSpecifier ||
        !ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        continue;
      }
      const target = resolveModule(
        file,
        statement.moduleSpecifier.text,
        parsed,
        packages,
      );
      if (!target) continue;
      let original: string | null = null;
      if (ts.isImportDeclaration(statement)) {
        const bindings = statement.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
          for (const el of bindings.elements) {
            if (el.name.text === name)
              original = (el.propertyName ?? el.name).text;
          }
        }
      } else if (!statement.exportClause) {
        original = name; // export * from
      } else if (ts.isNamedExports(statement.exportClause)) {
        for (const el of statement.exportClause.elements) {
          if (el.name.text === name)
            original = (el.propertyName ?? el.name).text;
        }
      }
      if (original) {
        const there = definitionOf(target, original, hops + 1);
        if (there) return there;
      }
    }
    return null;
  }

  function walk(file: string, sf: ts.SourceFile, record: boolean): boolean {
    let grew = false;
    const sites: Array<[Shape, ts.Node]> = [];
    /*
     * true or false for a name bound from a value, "parameter" for one a
     * caller supplies — which is a request value when it is called `body` or
     * `payload`, by the convention, and otherwise only when a call was seen
     * handing it one. `const body = await response.json()` is a reply from
     * somewhere else, and is not.
     */
    const scopes: Array<Map<string, boolean | "parameter">> = [];
    const isRequestName = (name: string): boolean => {
      for (let i = scopes.length - 1; i >= 0; i--) {
        const said = scopes[i]?.get(name);
        if (said === "parameter") return ALWAYS.has(name);
        if (said !== undefined) return said;
      }
      return ALWAYS.has(name);
    };
    /*
     * Not called `declare`: Bun's transpiler reads a statement beginning
     * `declare(` as a TypeScript ambient declaration and drops it, which made
     * an earlier draft of this sweep bind nothing and report every repository
     * clean.
     */
    const bind = (name: string, request: boolean | "parameter") =>
      scopes[scopes.length - 1]?.set(name, request);

    /** Whether this expression is a value the request sent. */
    const fromRequest = (expression: ts.Expression): boolean => {
      let node = peel(expression);
      // Array.isArray(body.lines) ? body.lines : [] is still the request's,
      // and so is [["start", body.start], ["end", body.end]].
      if (ts.isConditionalExpression(node)) {
        return fromRequest(node.whenTrue) || fromRequest(node.whenFalse);
      }
      if (ts.isArrayLiteralExpression(node)) {
        return node.elements.some(
          (e) =>
            !ts.isSpreadElement(e) &&
            !ts.isOmittedExpression(e) &&
            fromRequest(e),
        );
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression)
      ) {
        const callee = node.expression;
        // c.req.json(), and the same with .catch(() => ({})) after it.
        if (
          READS.has(callee.name.text) &&
          /(^|\.)req$/.test(callee.expression.getText(sf))
        ) {
          return true;
        }
        // .catch() on a read, form.get("x"), and a list's own iterators.
        if (/^(catch|get|entries|values|slice)$/.test(callee.name.text)) {
          return fromRequest(callee.expression);
        }
        return false;
      }
      while (
        ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)
      ) {
        node = peel(node.expression);
      }
      return ts.isIdentifier(node) && isRequestName(node.text);
    };

    /** A callback handed each element of a list the request sent. */
    const elementOfRequestList = (fn: ts.SignatureDeclaration): boolean => {
      const call = fn.parent;
      return (
        (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) &&
        ts.isCallExpression(call) &&
        call.arguments[0] === fn &&
        ts.isPropertyAccessExpression(call.expression) &&
        /^(map|forEach|filter|some|every|flatMap|find|findIndex)$/.test(
          call.expression.name.text,
        ) &&
        fromRequest(call.expression.expression)
      );
    };

    const isLiteral = (node: ts.Expression, ...texts: string[]) =>
      ts.isStringLiteralLike(node) &&
      (texts.length === 0 || texts.includes(node.text));

    const visit = (node: ts.Node): void => {
      const opensScope =
        ts.isSourceFile(node) ||
        ts.isBlock(node) ||
        ts.isFunctionLike(node) ||
        ts.isForStatement(node) ||
        ts.isForOfStatement(node) ||
        ts.isForInStatement(node) ||
        ts.isCatchClause(node);
      if (opensScope) scopes.push(new Map());

      if (ts.isFunctionLike(node)) {
        const name = functionName(node);
        const seeded = name ? seeds.get(`${file}#${name}`) : undefined;
        // body.lines.map((line) => …): each line is the request's too.
        const element = elementOfRequestList(node);
        node.parameters.forEach((parameter, i) => {
          for (const n of bindingNames(parameter.name)) {
            bind(
              n,
              seeded?.has(i) || (i === 0 && element) ? true : "parameter",
            );
          }
        });
      }

      // for (const line of body.lines): the same.
      if (
        (ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
        ts.isVariableDeclarationList(node.initializer)
      ) {
        visit(node.expression);
        const request =
          ts.isForOfStatement(node) && fromRequest(node.expression);
        for (const declaration of node.initializer.declarations) {
          for (const n of bindingNames(declaration.name)) bind(n, request);
        }
        visit(node.statement);
        scopes.pop();
        return;
      }

      if (ts.isVariableDeclaration(node) && node.initializer) {
        // The initializer is read before the name exists, as in the language.
        visit(node.initializer);
        const request = fromRequest(node.initializer);
        for (const n of bindingNames(node.name)) bind(n, request);
        if (!ts.isIdentifier(node.name)) visit(node.name);
        return;
      }

      /*
       * `body = await c.req.json()`, and `patch[field] = body[field]`: an
       * object a request value was copied into unread holds one too, which
       * is how `patch.seats` and `Number(patch.priceCents)` were read.
       */
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        fromRequest(node.right)
      ) {
        let target: ts.Expression = node.left;
        while (
          ts.isPropertyAccessExpression(target) ||
          ts.isElementAccessExpression(target)
        ) {
          target = target.expression;
        }
        if (ts.isIdentifier(target)) {
          for (let i = scopes.length - 1; i >= 0; i--) {
            if (scopes[i]?.has(target.text)) {
              scopes[i]?.set(target.text, true);
              break;
            }
          }
        }
      }

      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const only = node.arguments[0];
        if (ts.isIdentifier(callee) && only && node.arguments.length === 1) {
          if (
            (callee.text === "String" || callee.text === "Number") &&
            fromRequest(only)
          ) {
            sites.push([callee.text === "String" ? "text" : "number", node]);
          }
          if (callee.text === "Boolean" && fromRequest(only)) {
            sites.push(["flag", node]);
          }
        }
        if (
          ts.isPropertyAccessExpression(callee) &&
          callee.expression.getText(sf) === "Number" &&
          /^is(Integer|SafeInteger|Finite)$/.test(callee.name.text) &&
          only &&
          fromRequest(only) &&
          !(
            ts.isPrefixUnaryExpression(node.parent) &&
            node.parent.operator === ts.SyntaxKind.ExclamationToken
          )
        ) {
          sites.push(["shape", node]);
        }
        // A request value handed on: the helper's parameter is one too.
        if (ts.isIdentifier(callee)) {
          node.arguments.forEach((argument, i) => {
            if (!fromRequest(argument)) return;
            // An as* checker is where a request value is meant to be read.
            if (/^as[A-Z]/.test(callee.text)) return;
            const target = definitionOf(file, callee.text);
            if (!target) return;
            const positions = seeds.get(target) ?? new Set<number>();
            if (!positions.has(i)) {
              positions.add(i);
              seeds.set(target, positions);
              grew = true;
            }
          });
        }
      }

      if (
        ts.isPrefixUnaryExpression(node) &&
        node.operator === ts.SyntaxKind.ExclamationToken &&
        ts.isPrefixUnaryExpression(node.operand) &&
        node.operand.operator === ts.SyntaxKind.ExclamationToken &&
        fromRequest(node.operand.operand)
      ) {
        sites.push(["flag", node]);
      }

      if (ts.isBinaryExpression(node)) {
        const op = node.operatorToken.kind;
        const sides: Array<[ts.Expression, ts.Expression]> = [
          [node.left, node.right],
          [node.right, node.left],
        ];
        for (const [value, against] of sides) {
          // body.x === true, and !== false: anything else is quietly the other.
          if (
            WATCHED_FLAG_OPERATORS.has(op) &&
            (against.kind === ts.SyntaxKind.TrueKeyword ||
              against.kind === ts.SyntaxKind.FalseKeyword) &&
            fromRequest(value)
          ) {
            sites.push(["flag", node]);
          }
          // typeof body.x === "string" — read only when already that type.
          if (
            op === ts.SyntaxKind.EqualsEqualsEqualsToken &&
            ts.isTypeOfExpression(value) &&
            fromRequest(value.expression)
          ) {
            if (isLiteral(against, "string", "number"))
              sites.push(["shape", node]);
            if (isLiteral(against, "boolean")) sites.push(["flag", node]);
          }
        }
      }

      // body.x === "public" ? "public" : "private", and KINDS.includes(body.x) ? …
      if (ts.isConditionalExpression(node)) {
        const test = peel(node.condition);
        const comparesWord =
          ts.isBinaryExpression(test) &&
          test.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
          ((fromRequest(test.left) && isLiteral(test.right)) ||
            (fromRequest(test.right) && isLiteral(test.left))) &&
          isLiteral(peel(node.whenTrue)) &&
          isLiteral(peel(node.whenFalse));
        const asksAList =
          ts.isCallExpression(test) &&
          ts.isPropertyAccessExpression(test.expression) &&
          /^(includes|has)$/.test(test.expression.name.text) &&
          test.arguments[0] !== undefined &&
          fromRequest(test.arguments[0]);
        if (comparesWord || asksAList) sites.push(["choice", node]);
        // isKind(body.kind) ? body.kind : "text" — asked, and defaulted.
        const asked: ts.Expression[] = [];
        const collect = (expression: ts.Expression): void => {
          const e = peel(expression);
          if (
            ts.isBinaryExpression(e) &&
            e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
          ) {
            collect(e.left);
            collect(e.right);
          } else if (
            ts.isCallExpression(e) &&
            ts.isIdentifier(e.expression) &&
            !/^as[A-Z]/.test(e.expression.text)
          ) {
            asked.push(...e.arguments.filter((a) => fromRequest(a)));
          }
        };
        collect(node.condition);
        const kept = peel(node.whenTrue).getText(sf);
        if (!asksAList && asked.some((a) => peel(a).getText(sf) === kept)) {
          sites.push(["shape", node]);
        }
      }

      ts.forEachChild(node, visit);
      if (opensScope) scopes.pop();
    };

    visit(sf);
    if (record) {
      for (const [shape, node] of sites) {
        if (keepsNothing(node)) continue;
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        const at = `${relative(repo, file)}:${line + 1}`;
        if (!found[shape].includes(at)) found[shape].push(at);
      }
    }
    return grew;
  }

  // Until no call hands a request value to a parameter not already followed.
  for (let round = 0; round < 10; round++) {
    let grew = false;
    for (const [file, sf] of parsed) grew = walk(file, sf, false) || grew;
    if (!grew) break;
  }
  for (const [file, sf] of parsed) walk(file, sf, true);
  for (const list of Object.values(found)) list.sort();

  const analysis = { sites: found };
  analyses.set(key, analysis);
  return analysis;
}

/** Each `file:line` that coerces a request value into text. */
export function coercedTextSites(repo: string, where: string[]): string[] {
  return analyse(repo, where).sites.text;
}

/** Each `file:line` that coerces a request value into a number. */
export function coercedNumberSites(repo: string, where: string[]): string[] {
  return analyse(repo, where).sites.number;
}

export const WHY_NOT_NUMBER =
  'these turn a request value into a number with Number(), and Number([]) is 0 — so a list sent where a price belongs passes every range check — use asWholeNumber(body.x, "x") or asNumber from @sentrello/db/request-values';

export const WHY_NOT_STRING =
  'these turn a request value into text with String(), which stores an object as the words "[object Object]" and refuses nothing — use asText(body.x, "x") from @sentrello/db/text-columns';

/**
 * Each `file:line` that turns an unknown choice into a default instead of
 * refusing it: `body.visibility === "public" ? "public" : "private"` answered
 * 201 to "pubic" and made a private list, and `KINDS.includes(body.kind) ?
 * body.kind : "text"` is the same with a list of words.
 */
export function defaultedChoiceSites(repo: string, where: string[]): string[] {
  return analyse(repo, where).sites.choice;
}

export const WHY_NOT_DEFAULTED =
  'these turn a choice nobody offered into the default and answer 2xx, so the caller is told it worked — use asChoice(body.x, "x", [...choices], fallback) from @sentrello/db/request-values, which refuses an unknown word with a 400 naming the field';

/**
 * Each `file:line` that reads a request flag by comparison or coercion instead
 * of asking. `body.x === true` makes `{}`, "yes" and `[true]` all false, and
 * `!!body.x` makes them all true; `typeof body.x === "boolean" ? body.x :
 * current` is the worst, because it keeps the old value and says it saved.
 */
export function coercedFlagSites(repo: string, where: string[]): string[] {
  return analyse(repo, where).sites.flag;
}

export const WHY_NOT_FLAG =
  'these read true or false by comparing or coercing, so {}, "yes" and [true] are quietly one or the other and the caller is told it worked — use asFlag(body.x, "x", fallback) from @sentrello/db/request-values';

/**
 * Each `file:line` that turns a wrongly typed request value into nothing or a
 * default. `typeof body.email === "string" ? body.email : null` turns `{}` into
 * null, and on an edit null is what gets stored; `Number.isInteger(body.seats)
 * ? body.seats : 1` turns "three" into one. The negated spellings,
 * `typeof body.x !== "string"` and `!Number.isInteger(body.x)`, are refusals
 * and pass.
 */
export function guessedShapeSites(repo: string, where: string[]): string[] {
  return analyse(repo, where).sites.shape;
}

export const WHY_NOT_GUESSED =
  'these read a request value only when it is already the right type, so {}, [] or "three" quietly become nothing or a default — on an edit that wipes what was stored — and the caller is told it worked; use asTextOrNothing, asIdOrNothing, asWholeNumberOrNothing or asNumberOrNothing from @sentrello/db/request-values, which keep absent as absent and refuse a wrong type with a 400 naming the field';
