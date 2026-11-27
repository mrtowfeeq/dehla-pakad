"""Helpers for keeping persisted operational records in one Clerk environment."""


ENVIRONMENTS = frozenset({"preview", "live"})


class EnvironmentMigrationConflict(RuntimeError):
    """An explicit legacy assignment conflicts with the record's current owner."""


def scoped_query(query, environment):
    """Return a query constrained to an environment when one is configured."""
    result = dict(query)
    if environment is not None:
        result["env"] = environment
    return result


async def assign_explicit_legacy_environment(collection, assignments, *, dry_run=True):
    """Tag only explicitly mapped untagged documents; never infer an environment.

    ``assignments`` is an iterable of ``{"_id": ..., "env": "preview|live"}``
    rows prepared and reviewed by an operator. Dry-run is the default. Apply is
    idempotent and only updates documents whose env is missing or null.
    """
    rows = list(assignments)
    if not rows:
        return {"dry_run": bool(dry_run), "would_tag": 0, "already_tagged": 0, "tagged": 0}

    seen_ids = set()
    normalized = []
    for row in rows:
        if not isinstance(row, dict) or "_id" not in row or row["_id"] is None:
            raise ValueError("Every assignment must specify a document _id")
        if row.get("env") not in ENVIRONMENTS:
            raise ValueError("Every assignment must specify env as 'preview' or 'live'")
        try:
            if row["_id"] in seen_ids:
                raise ValueError("A document may only appear once in an assignment batch")
            seen_ids.add(row["_id"])
        except TypeError as exc:
            raise ValueError("Document _id values must be hashable") from exc
        normalized.append((row["_id"], row["env"]))

    # Preflight the complete batch so known conflicts do not cause partial writes.
    states = []
    for document_id, environment in normalized:
        document = await collection.find_one({"_id": document_id}, {"_id": 1, "env": 1})
        if document is None:
            raise EnvironmentMigrationConflict(f"Document {document_id!r} does not exist")
        current = document.get("env")
        if current is not None and current != environment:
            raise EnvironmentMigrationConflict(f"Document {document_id!r} is already assigned to {current!r}")
        states.append(current == environment)

    already_tagged = sum(states)
    would_tag = len(states) - already_tagged
    if dry_run:
        return {"dry_run": True, "would_tag": would_tag, "already_tagged": already_tagged, "tagged": 0}

    tagged = 0
    for (document_id, environment), is_assigned in zip(normalized, states):
        if is_assigned:
            continue
        result = await collection.update_one(
            {"_id": document_id, "$or": [{"env": {"$exists": False}}, {"env": None}]},
            {"$set": {"env": environment}},
        )
        if result.matched_count == 1:
            tagged += 1
            continue
        # A concurrent rerun that assigned this same explicit value is safe;
        # any other state change is a conflict and must be reviewed.
        latest = await collection.find_one({"_id": document_id}, {"_id": 1, "env": 1})
        if latest is None or latest.get("env") != environment:
            raise EnvironmentMigrationConflict(f"Document {document_id!r} changed during migration")
        already_tagged += 1

    return {"dry_run": False, "would_tag": would_tag, "already_tagged": already_tagged, "tagged": tagged}

