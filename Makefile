.PHONY: test build-frontend verify docker-build docker-up clean

test:
	PYTHONPATH=backend python -m compileall -q backend/app backend/integrations
	PYTHONPATH=backend pytest -q backend/tests

build-frontend:
	cd frontend && npm install --no-audit --no-fund && npm run build

verify: test build-frontend

docker-build:
	docker compose build

docker-up:
	docker compose up -d

clean:
	find . -type d \( -name __pycache__ -o -name .pytest_cache -o -name dist \) -prune -exec rm -rf {} +
