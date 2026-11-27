"""Resolve request addresses without trusting forwarding headers from clients."""

import ipaddress
import os
from functools import lru_cache


@lru_cache(maxsize=16)
def _trusted_networks(raw):
    networks = []
    for entry in raw.split(","):
        value = entry.strip()
        if not value:
            continue
        try:
            networks.append(ipaddress.ip_network(value, strict=False))
        except ValueError:
            # Invalid proxy configuration never expands the trust boundary.
            continue
    return tuple(networks)


def _is_trusted(address, networks):
    return any(address.version == network.version and address in network for network in networks)


def client_ip(request, *, trusted_cidrs=None):
    """Use X-Forwarded-For only when the direct TCP peer is a configured proxy.

    Walk the forwarded chain from right to left, trusting each hop only while the
    hop currently being considered is itself in the configured proxy networks.
    """
    try:
        peer = ipaddress.ip_address(request.client.host if request.client else "")
    except ValueError:
        return "unknown"

    raw_trusted = os.environ.get("TRUSTED_PROXY_CIDRS", "")
    networks = _trusted_networks(raw_trusted if trusted_cidrs is None else trusted_cidrs)
    if not _is_trusted(peer, networks):
        return peer.compressed

    forwarded = request.headers.get("x-forwarded-for", "")
    if not forwarded or len(forwarded) > 2048:
        return peer.compressed
    try:
        hops = [ipaddress.ip_address(value.strip()) for value in forwarded.split(",")]
    except ValueError:
        return peer.compressed

    client = peer
    for hop in reversed(hops):
        if not _is_trusted(client, networks):
            break
        client = hop
    return client.compressed


def trusted_proxy_header(request, name, *, trusted_cidrs=None):
    """Return a forwarding header only when the direct peer is a trusted proxy."""
    try:
        peer = ipaddress.ip_address(request.client.host if request.client else "")
    except ValueError:
        return None
    raw_trusted = os.environ.get("TRUSTED_PROXY_CIDRS", "")
    networks = _trusted_networks(raw_trusted if trusted_cidrs is None else trusted_cidrs)
    if not _is_trusted(peer, networks):
        return None
    return request.headers.get(name)

