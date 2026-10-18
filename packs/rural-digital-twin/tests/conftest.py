# The rural pack's tests: registered before any test module imports the
# core's scene, store or api (see civic_engagement/domain.py). Run them from
# the directory holding data/ (the site's files).
from civic_engagement.domain import register
from rural_digital_twin.pack import RuralPack

register(RuralPack())
