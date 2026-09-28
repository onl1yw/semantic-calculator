from copy import deepcopy

import pytest

from scripts.deploy_yandex import has_public_bindings, revision_command, verify_revision


def revision():
    return {"status": "ACTIVE", "scaling_policy": {"zone_instances_limit": "1", "zone_requests_limit": "4"},
            "provision_policy": {}, "resources": {"memory": "268435456", "cores": "1", "core_fraction": "20"},
            "concurrency": "4", "execution_timeout": "3s",
            "image": {"environment": {"SC_VERIFY_DICTIONARY": "true"}}}


def test_release_accepts_only_confirmed_small_active_revision():
    verify_revision(revision())


@pytest.mark.parametrize("identifier", ["allUsers", "allAuthenticatedUsers"])
def test_yandex_system_subjects_are_recognized_as_public_access(identifier):
    assert has_public_bindings([{"subject": {"type": "system", "id": identifier},
                                 "role_id": "serverless-containers.containerInvoker"}])


def test_project_service_account_binding_is_private():
    assert not has_public_bindings([{"subject": {"type": "serviceAccount", "id": "project-gateway"},
                                     "role_id": "serverless-containers.containerInvoker"}])


@pytest.mark.parametrize("field,change", [
    ("status", "CREATING"),
    ("scaling_policy", {}),
    ("scaling_policy", {"zone_instances_limit": "2", "zone_requests_limit": "4"}),
    ("scaling_policy", {"zone_instances_limit": "1", "zone_requests_limit": "100"}),
    ("provision_policy", {"min_instances": "1"}),
    ("resources", {"memory": "1073741824", "cores": "1", "core_fraction": "20"}),
    ("resources", {"memory": "268435456", "cores": "2", "core_fraction": "100"}),
    ("execution_timeout", "30s"), ("concurrency", "16"),
    ("image", {}),
    ("image", {"environment": {"SC_VERIFY_DICTIONARY": "false"}}),
    ("image", {"environment": {"SC_VERIFY_DICTIONARY": "true", "SC_YDB_DATABASE": "/obsolete"}}),
])
def test_release_refuses_to_connect_gateway_with_larger_or_missing_limits(field, change):
    value = deepcopy(revision())
    value[field] = change
    with pytest.raises(RuntimeError, match="gateway"):
        verify_revision(value)


def test_release_needs_only_registry_runtime_identity_and_local_dictionary():
    command = revision_command("container", {"runtime_account_id": "runtime"}, "image@sha256:digest")
    environment = dict(item.split("=", 1) for item in command[command.index("--environment") + 1].split(","))
    assert environment["SC_VERIFY_DICTIONARY"] == "true"
    assert not any("YDB" in key or key == "SC_STORE_BACKEND" for key in environment)
