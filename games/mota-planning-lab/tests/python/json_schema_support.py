from __future__ import annotations

import json
import re
from typing import Any, Dict


class JsonSchemaAssertionError(AssertionError):
    pass


def _resolve(root: Dict[str, Any], reference: str) -> Dict[str, Any]:
    if not reference.startswith("#/"):
        raise JsonSchemaAssertionError(f"unsupported external $ref: {reference}")
    current: Any = root
    for token in reference[2:].split("/"):
        token = token.replace("~1", "/").replace("~0", "~")
        current = current[token]
    if not isinstance(current, dict):
        raise JsonSchemaAssertionError(f"$ref does not resolve to an object: {reference}")
    return current


def _is_type(value: Any, expected: str) -> bool:
    if expected == "null":
        return value is None
    if expected == "object":
        return isinstance(value, dict)
    if expected == "array":
        return isinstance(value, list)
    if expected == "string":
        return isinstance(value, str)
    if expected == "boolean":
        return isinstance(value, bool)
    if expected == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    raise JsonSchemaAssertionError(f"unsupported JSON Schema type: {expected}")


def assert_json_schema_instance(
    value: Any,
    schema: Dict[str, Any],
    *,
    root: Dict[str, Any] | None = None,
    path: str = "$",
) -> None:
    """Validate the checked-in protocol schema subset without third-party deps.

    The project schemas intentionally use a small Draft 2020-12 subset.  This
    validator covers every keyword currently present and fails loudly if the
    contract grows a keyword that needs explicit support.
    """

    root = schema if root is None else root
    supported_keywords = {
        "$schema",
        "$id",
        "$defs",
        "$ref",
        "title",
        "oneOf",
        "anyOf",
        "allOf",
        "if",
        "then",
        "not",
        "const",
        "enum",
        "type",
        "additionalProperties",
        "required",
        "properties",
        "minProperties",
        "minItems",
        "maxItems",
        "items",
        "minLength",
        "maxLength",
        "pattern",
        "minimum",
        "maximum",
        "uniqueItems",
    }
    unsupported = set(schema) - supported_keywords
    if unsupported:
        raise JsonSchemaAssertionError(
            f"{path}: unsupported schema keywords {sorted(unsupported)!r}"
        )
    if "$ref" in schema:
        assert_json_schema_instance(value, _resolve(root, schema["$ref"]), root=root, path=path)
        return

    for branch in schema.get("allOf", []):
        assert_json_schema_instance(value, branch, root=root, path=path)

    if "if" in schema and "then" in schema:
        try:
            assert_json_schema_instance(value, schema["if"], root=root, path=path)
        except JsonSchemaAssertionError:
            pass
        else:
            assert_json_schema_instance(value, schema["then"], root=root, path=path)

    if "not" in schema:
        try:
            assert_json_schema_instance(value, schema["not"], root=root, path=path)
        except JsonSchemaAssertionError:
            pass
        else:
            raise JsonSchemaAssertionError(f"{path}: forbidden schema matched")

    if "oneOf" in schema:
        matches = 0
        errors = []
        for branch in schema["oneOf"]:
            try:
                assert_json_schema_instance(value, branch, root=root, path=path)
                matches += 1
            except JsonSchemaAssertionError as exc:
                errors.append(str(exc))
        if matches != 1:
            raise JsonSchemaAssertionError(
                f"{path}: expected exactly one oneOf match, found {matches}; {errors}"
            )
        return

    if "anyOf" in schema:
        for branch in schema["anyOf"]:
            try:
                assert_json_schema_instance(value, branch, root=root, path=path)
                return
            except JsonSchemaAssertionError:
                pass
        raise JsonSchemaAssertionError(f"{path}: no anyOf branch matched")

    if "const" in schema and value != schema["const"]:
        raise JsonSchemaAssertionError(f"{path}: expected const {schema['const']!r}")
    if "enum" in schema and value not in schema["enum"]:
        raise JsonSchemaAssertionError(f"{path}: value is not in enum")

    expected_types = schema.get("type")
    if expected_types is not None:
        expected_types = [expected_types] if isinstance(expected_types, str) else expected_types
        if not any(_is_type(value, expected) for expected in expected_types):
            raise JsonSchemaAssertionError(f"{path}: expected type {expected_types!r}")
        if value is None:
            return

    if isinstance(value, dict):
        required = set(schema.get("required", []))
        missing = required - set(value)
        if missing:
            raise JsonSchemaAssertionError(f"{path}: missing required fields {sorted(missing)!r}")
        if len(value) < schema.get("minProperties", 0):
            raise JsonSchemaAssertionError(f"{path}: too few properties")
        properties = schema.get("properties", {})
        if schema.get("additionalProperties") is False:
            extra = set(value) - set(properties)
            if extra:
                raise JsonSchemaAssertionError(f"{path}: extra fields {sorted(extra)!r}")
        for key, item in value.items():
            if key in properties:
                assert_json_schema_instance(
                    item,
                    properties[key],
                    root=root,
                    path=f"{path}.{key}",
                )
        return

    if isinstance(value, list):
        if len(value) < schema.get("minItems", 0):
            raise JsonSchemaAssertionError(f"{path}: too few items")
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            raise JsonSchemaAssertionError(f"{path}: too many items")
        if schema.get("uniqueItems") is True:
            normalized = [json.dumps(item, sort_keys=True, separators=(",", ":")) for item in value]
            if len(normalized) != len(set(normalized)):
                raise JsonSchemaAssertionError(f"{path}: array items are not unique")
        if "items" in schema:
            for index, item in enumerate(value):
                assert_json_schema_instance(
                    item,
                    schema["items"],
                    root=root,
                    path=f"{path}[{index}]",
                )
        return

    if isinstance(value, str):
        if len(value) < schema.get("minLength", 0):
            raise JsonSchemaAssertionError(f"{path}: string is too short")
        if "maxLength" in schema and len(value) > schema["maxLength"]:
            raise JsonSchemaAssertionError(f"{path}: string is too long")
        if "pattern" in schema and re.search(schema["pattern"], value) is None:
            raise JsonSchemaAssertionError(f"{path}: string does not match pattern")
        return

    if isinstance(value, int) and not isinstance(value, bool):
        if "minimum" in schema and value < schema["minimum"]:
            raise JsonSchemaAssertionError(f"{path}: integer is below minimum")
        if "maximum" in schema and value > schema["maximum"]:
            raise JsonSchemaAssertionError(f"{path}: integer is above maximum")
