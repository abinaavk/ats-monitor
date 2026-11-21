"""Load the installed ATS transport. Deployment logic lives exclusively in ATS."""
import os
from pathlib import Path
import shlex
import sys


def _transport_dir():
    # An explicit installation must never silently load another checkout.
    if 'ATS_MODULE_DIR' in os.environ:
        return Path(os.environ['ATS_MODULE_DIR'])
    if os.environ.get('ATS_CLI'):
        try:
            argv = shlex.split(os.environ['ATS_CLI'])
        except ValueError as exc:
            raise RuntimeError('ATS_CLI is malformed; set ATS_MODULE_DIR to the ATS checkout') from exc
        for arg in argv:
            script = Path(arg)
            if script.is_absolute() and script.suffix == '.py':
                return script.resolve().parent
        raise RuntimeError('Set ATS_MODULE_DIR to the ATS checkout when ATS_CLI uses a wrapper or module')
    sibling = Path(__file__).resolve().parent.parent / 'ats'
    if (sibling / 'ats_cluster.py').is_file():
        return sibling
    # Match manage_api.DEFAULT_ATS_CLI, the existing installed CLI default.
    return Path('/home/gaia/ats')


_transport = _transport_dir()
if not (_transport / 'ats_cluster.py').is_file():
    raise ModuleNotFoundError(
        'ATS multi-server transport is missing. Install/update abinaavk/ats and '
        'set ATS_MODULE_DIR in the Monitor service environment to the absolute '
        'directory containing ats_cluster.py (for example /ats). '
        'This module is supplied by ATS, not a PyPI requirement.'
    )
# Keep Monitor's own app.py ahead of ATS's identically named entry point.
sys.path.append(str(_transport))
from ats_cluster import Store, remote, MAX_BODY
try:
    from ats_cluster import TransportError
except ImportError:  # An older ATS: failures fall back to generic wording.
    class TransportError(Exception):
        code = 'transport'


def registry(store_factory=Store):
    """Opening a legacy Monitor must not create or require a new /etc database."""
    path = os.environ.get('ATS_CLUSTER_DB', '/etc/ats/cluster.sqlite3')
    try:
        os.stat(path)
    except FileNotFoundError:
        return None
    return store_factory(path)


def configured_node():
    store = registry()
    return store.node() if store else None
