"""Load the installed ATS transport. Deployment logic lives exclusively in ATS."""
import os
from pathlib import Path
import sys
sys.path.append(os.environ.get('ATS_MODULE_DIR', str(Path(__file__).resolve().parent.parent / 'ats')))
from ats_cluster import Store, remote, MAX_BODY


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
