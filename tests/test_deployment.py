from copy import deepcopy

import pytest

from scripts.deploy_yandex import has_public_bindings, revision_command, verify_revision
from scripts.deploy_frontend import frontend_manifest, publish_frontend
from scripts.yandex_gateway import gateway_spec


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


@pytest.fixture
def frontend_dist(tmp_path):
    (tmp_path / "assets").mkdir()
    (tmp_path / "index.html").write_text('<html><script src="/assets/index-12345678.js"></script></html>')
    (tmp_path / "assets/index-12345678.js").write_text("console.log('frontend')")
    (tmp_path / "card.png").write_bytes(b"preview-image")
    (tmp_path / "favicon.svg").write_text("<svg/>")
    return tmp_path


def test_static_routes_never_invoke_container_and_api_remains_protected(frontend_dist):
    spec = gateway_spec("container", "gateway", "security", frontend_manifest(frontend_dist, "private-bucket"))
    assert spec["x-yc-apigateway"]["smartWebSecurity"]["securityProfileId"] == "security"
    for path, methods in spec["paths"].items():
        if path.startswith("/api/"):
            for operation in methods.values():
                assert operation["x-yc-apigateway-integration"] == {
                    "type": "serverless_containers", "container_id": "container", "service_account_id": "gateway"}
        else:
            assert set(methods) == {"get", "head"}
            for operation in methods.values():
                assert operation["x-yc-apigateway-integration"]["type"] in {"dummy", "object_storage"}
    assert set(spec["paths"]["/api/nearest"]) == {"post"}
    assert "frame-ancestors 'none'" in spec["paths"]["/"]["get"]["x-yc-apigateway-integration"]["http_headers"]["Content-Security-Policy"]


def test_frontend_publication_excludes_private_files_and_source_maps(frontend_dist):
    (frontend_dist / ".env").write_text("private configuration")
    (frontend_dist / "vectors.npy").write_bytes(b"private dictionary")
    (frontend_dist / "assets/index-12345678.js.map").write_text("source map")
    manifest = frontend_manifest(frontend_dist, "private-bucket")
    assert set(manifest["sha256"]) == {
        "index.html", "assets/index-12345678.js", "card.png", "favicon.svg", "LICENSE", "NOTICE"}


def test_frontend_release_changes_with_content_and_keeps_shared_asset_keys(frontend_dist):
    original = frontend_manifest(frontend_dist, "private-bucket")
    (frontend_dist / "card.png").write_bytes(b"updated-preview")
    changed = frontend_manifest(frontend_dist, "private-bucket")
    assert original["prefix"] != changed["prefix"]
    for manifest in (original, changed):
        spec = gateway_spec("container", "gateway", "security", manifest)
        integration = spec["paths"]["/assets/{file+}"]["get"]["x-yc-apigateway-integration"]
        assert integration["object"] == "assets/{file}"


def test_frontend_release_rejects_missing_assets_and_symlinks(frontend_dist):
    asset = frontend_dist / "assets/index-12345678.js"
    asset.unlink()
    with pytest.raises(ValueError, match="missing asset"):
        frontend_manifest(frontend_dist, "private-bucket")
    asset.symlink_to(frontend_dist / "favicon.svg")
    with pytest.raises(ValueError, match="linked frontend"):
        frontend_manifest(frontend_dist, "private-bucket")


def test_frontend_publication_refuses_public_or_wrong_folder_bucket(frontend_dist):
    for bucket in ({"folder_id": "another"},
                   {"folder_id": "project", "anonymous_access_flags": {"read": True}}):
        calls = []

        def call(*command):
            calls.append(command)
            return bucket

        with pytest.raises(RuntimeError, match="private frontend bucket"):
            publish_frontend(call, {"frontend_bucket": "bucket", "folder_id": "project"}, frontend_dist)
        assert len(calls) == 1
