# The urban pack's tests: registered before any test module imports the
# core's scene, store or api (see civic_engagement/domain.py). Run them from
# the directory holding data/ (the sites' files).
from bologna_civic_dt.pack import UrbanPack
from civic_engagement.domain import register

register(UrbanPack())
