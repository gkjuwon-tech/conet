"""Auth-header selection — the SDK has to pick the right header for the
key prefix or the backend will reject the request.

The backend resolver lives in ``backend/app/auth/dependencies.py`` and
accepts these three header families:

* ``X-Cluster-Key`` (cluster keys only, data plane)
* ``X-API-Key`` (both kinds)
* ``Authorization: Bearer …`` (legacy, both kinds)

This test pins the SDK's outgoing header decision so we don't accidentally
break interop with a server that only honours one of them.
"""

from __future__ import annotations

import pytest

from conet._http import _build_auth_headers
from conet.compute import ClusterClient
from conet.client import ConetClient


def test_cluster_key_sends_cluster_header() -> None:
    headers = _build_auth_headers("em_cluster_abcdef1234567890")
    assert headers == {
        "X-Cluster-Key": "em_cluster_abcdef1234567890",
        "X-API-Key": "em_cluster_abcdef1234567890",
    }


def test_access_key_sends_xapikey_only() -> None:
    headers = _build_auth_headers("em_live_abcdef1234567890")
    assert headers == {"X-API-Key": "em_live_abcdef1234567890"}


def test_unknown_prefix_sends_both_xapikey_and_bearer() -> None:
    headers = _build_auth_headers("legacy_key_xyz")
    assert headers == {
        "X-API-Key": "legacy_key_xyz",
        "Authorization": "Bearer legacy_key_xyz",
    }


def test_cluster_client_refuses_access_key() -> None:
    with pytest.raises(ValueError, match="em_cluster_"):
        ClusterClient(api_key="em_live_bad")


def test_cluster_client_refuses_empty_key() -> None:
    with pytest.raises(ValueError, match="required"):
        ClusterClient(api_key="")


def test_conet_client_refuses_cluster_key() -> None:
    with pytest.raises(ValueError, match="em_live_"):
        ConetClient(api_key="em_cluster_bad")


def test_conet_client_refuses_empty_key() -> None:
    with pytest.raises(ValueError, match="required"):
        ConetClient(api_key="")
