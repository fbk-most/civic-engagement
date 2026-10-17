# The tests run against the urban pack: registered before any test module
# imports the core's scene, store or api (see civic_engagement/domain.py).
from bologna_civic_dt.pack import UrbanPack
from civic_engagement.domain import register

register(UrbanPack())
