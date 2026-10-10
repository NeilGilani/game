"""Check generated consent functions on data, without running arbitrary code.

Only a small, pure AST subset is accepted. No imports, loops, comprehensions,
dunder attributes, file/network calls, or arbitrary method calls can execute.
Uncheckable code is reported as unverified rather than guessed correct.
"""
import ast
import re


def check_consent(text: str) -> dict:
    blocks = re.findall(r"```(?:python)?\s*\n(.*?)```", text, re.S)
    if not blocks:
        return {"status": "unverified", "reason": "No complete Python code block"}
    try:
        tree = ast.parse(blocks[0])
        function = next(node for node in tree.body if isinstance(node, ast.FunctionDef))
        allowed = (ast.FunctionDef, ast.arguments, ast.arg, ast.If, ast.Return, ast.Assign,
                   ast.Expr, ast.BoolOp, ast.And, ast.Or, ast.UnaryOp, ast.Not, ast.Compare,
                   ast.Eq, ast.NotEq, ast.Is, ast.IsNot, ast.In, ast.NotIn, ast.Subscript,
                   ast.Name, ast.Load, ast.Store, ast.Constant, ast.Call, ast.Attribute,
                   ast.Dict, ast.List, ast.Tuple, ast.keyword)
        nodes = list(ast.walk(function))
        if len(nodes) > 300 or any(not isinstance(node, allowed) for node in nodes):
            raise ValueError("Function uses unsupported AST constructs")
        for node in nodes:
            if isinstance(node, ast.Name) and node.id.startswith('__'):
                raise ValueError("Dunder names are forbidden")
            if isinstance(node, ast.Attribute) and node.attr != 'get':
                raise ValueError("Only dictionary get is supported")
            if isinstance(node, ast.Call) and not (
                isinstance(node.func, ast.Name) and node.func.id == 'bool'
                or isinstance(node.func, ast.Attribute) and node.func.attr == 'get'
            ):
                raise ValueError("Only bool and dictionary get calls are supported")
        if function.decorator_list or function.args.vararg or function.args.kwarg:
            raise ValueError("Decorators and variable arguments are unsupported")
        if not 1 <= len(function.args.args) <= 2:
            raise ValueError("Expected a record argument and optional purpose")
        # Strip annotations: they must not introduce evaluation at definition.
        function.returns = None
        for arg in function.args.args:
            arg.annotation = None
        function.args.defaults = []
        namespace = {"__builtins__": {}, "bool": bool}
        module = ast.fix_missing_locations(ast.Module(body=[function], type_ignores=[]))
        exec(compile(module, '<restricted-generated-consent>', 'exec'), namespace)
        func = namespace[function.name]
        valid = {"participant_id": "p-42", "signed_at": "2026-01-01T12:00:00Z",
                 "withdrawn_at": None, "purpose": "clinical_trial"}
        cases = [
            ("valid consent", valid, True),
            ("unsigned consent", {**valid, "signed_at": None}, False),
            ("withdrawn consent", {**valid, "withdrawn_at": "2026-02-01T12:00:00Z"}, False),
            ("missing purpose", {**valid, "purpose": ""}, False),
        ]
        checks = []
        for name, record, expected in cases:
            try:
                value = func(record, 'clinical_trial') if len(function.args.args) == 2 else func(record)
                checks.append({"case": name, "expected": expected, "actual": repr(value),
                               "passed": type(value) is bool and value is expected})
            except Exception as error:
                checks.append({"case": name, "expected": expected, "passed": False,
                               "error": f"{type(error).__name__}: {error}"})
        return {"status": "passed" if all(c['passed'] for c in checks) else "failed",
                "passed": sum(c['passed'] for c in checks), "total": len(checks), "checks": checks}
    except (SyntaxError, StopIteration, ValueError) as error:
        return {"status": "unverified", "reason": str(error) or 'No function definition'}
