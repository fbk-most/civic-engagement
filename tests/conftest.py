# The core's tests run against a toy pack (tests/toy_pack), registered before
# any test module imports the core's scene, store or api (see
# civic_engagement/domain.py).
from civic_engagement.domain import register
from tests.toy_pack import ToyPack

register(ToyPack())
