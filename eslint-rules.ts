import type { ESLint, JSSyntaxElement, Rule } from "eslint";

/**
Read an AST field without assuming the input is an object.
@param value - Unknown input to inspect.
@param key - Field name to read when the input is an object.
@returns The field value, or undefined when the input has no fields.
*/
function property(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

/**
Identify an AST node through its checked type field.
@param value - Possible AST node to inspect.
@returns The node type, or an empty string for other values.
*/
function typeOf(value: unknown): string {
  const type = property(value, "type");

  return typeof type === "string" ? type : "";
}

/**
Unwrap an exported declaration for placement analysis.
@param statement - Statement that may wrap a declaration.
@returns The enclosed declaration, or the original statement.
*/
function declarationOf(statement: unknown): unknown {
  return typeOf(statement) === "ExportNamedDeclaration" || typeOf(statement) === "ExportDefaultDeclaration"
    ? property(statement, "declaration")
    : statement;
}

/**
Recognize declarations that can share the beginning of a scope.
@param statement - Statement whose declaration category is needed.
@returns Whether the statement belongs to the declaration prefix.
*/
function isRuntimeDeclarationPrefix(statement: unknown): boolean {
  const declaration = declarationOf(statement);
  const declarationType = typeOf(declaration);

  return (
    property(declaration, "declare") === true ||
    [
      "VariableDeclaration",
      "FunctionDeclaration",
      "TSDeclareFunction",
      "TSTypeAliasDeclaration",
      "TSInterfaceDeclaration",
    ].includes(declarationType)
  );
}

/**
Permit imports, directives, and declarations before executable statements.
@param statement - Statement to classify within its scope.
@returns Whether subsequent variables may remain in the declaration prefix.
*/
function isDeclarationPrefix(statement: unknown): boolean {
  const type = typeOf(statement);

  return (
    type === "ImportDeclaration" ||
    type === "ExportAllDeclaration" ||
    (type === "ExportNamedDeclaration" && !property(statement, "declaration")) ||
    (type === "ExpressionStatement" && typeof property(statement, "directive") === "string") ||
    isRuntimeDeclarationPrefix(statement)
  );
}

const constOnTop: Rule.RuleModule = {
  meta: {
    type: "suggestion",
    docs: { description: "Keep const and let declarations in the declaration prefix of their scope." },
    schema: [],
    messages: { move: "Declare this variable at the top of its scope, before executable statements." },
  },
  create(context) {
    function inspectBody(body: unknown[]) {
      let hasExecutableStatement = false;

      for (const statement of body) {
        const declaration = declarationOf(statement);
        const kind = property(declaration, "kind");

        if (
          hasExecutableStatement &&
          typeOf(declaration) === "VariableDeclaration" &&
          (kind === "const" || kind === "let")
        ) {
          const location = property(declaration, "loc");
          const start = property(location, "start");
          const line = property(start, "line");
          const column = property(start, "column");

          if (typeof line === "number" && typeof column === "number") {
            context.report({ loc: { line, column }, messageId: "move" });
          }
        }

        if (!isDeclarationPrefix(statement)) {
          hasExecutableStatement = true;
        }
      }
    }

    function inspect(node: JSSyntaxElement) {
      const body = property(node, "body");

      if (Array.isArray(body)) {
        inspectBody(body);
      }
    }

    return { Program: inspect, BlockStatement: inspect, StaticBlock: inspect };
  },
};

const plugin: ESLint.Plugin = { rules: { "const-on-top": constOnTop } };

export default plugin;
