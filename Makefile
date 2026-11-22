# IF4031 Milestone 2 — One-Command Platform Orchestration (PLAT-5, MB3-T01)

SHELL := /bin/bash
NAMESPACE ?= sistem-informasi-kebencanaan-bnpb
OVERLAY ?= demo
IMAGE_REGISTRY ?= node-a:5000
IMAGE_TAG ?= m2
ENV_FILE ?= .env.local

SERVICES := bmkg-mock pvmbg-mock aggregator auth-service client-api dashboard-updater notifier storage-unit satellite-processor field-report-processor advisor analytics-dashboard

.PHONY: help dev-up up down build push secrets verify-labels verify-resources verify-netpol verify-manifests obs-vendor

help:
	@echo "Targets:"
	@echo "  make dev-up            Bootstrap local 3-node k3d cluster + local registry"
	@echo "  make secrets           Create Kubernetes Secrets from $(ENV_FILE) (never committed)"
	@echo "  make build             Build container images for all services"
	@echo "  make push              Push container images to $(IMAGE_REGISTRY)"
	@echo "  make up                Apply namespace, secrets, and all manifests via Kustomize ($(OVERLAY))"
	@echo "  make down              Delete application and observability namespaces"
	@echo "  make verify-labels     Assert all pods carry a valid TA-6 role label"
	@echo "  make verify-resources  Assert all containers match Lampiran B memory requests/limits"
	@echo "  make verify-netpol     Assert NetworkPolicy blocks role=api -> role=store (PLAT-8)"
	@echo "  make verify-manifests  Run offline static verification of Kustomize manifests"

dev-up:
	bash scripts/cluster/dev-up.sh

secrets:
	@if [ ! -f "$(ENV_FILE)" ]; then \
		echo "[secrets] $(ENV_FILE) not found; copying from .env.local.example..."; \
		cp .env.local.example "$(ENV_FILE)"; \
	fi
	kubectl apply -f deploy/k8s/base/namespace.yaml
	set -a && . "./$(ENV_FILE)" && set +a && \
	PVMBG_ACCESS_TOKEN="$${PVMBG_ACCESS_TOKEN:-$$(node -e 'const c=require("crypto");const b=o=>Buffer.from(JSON.stringify(o)).toString("base64url");const h=b({alg:"HS256",typ:"JWT"});const p=b({sub:"aggregator",aud:"pvmbg",exp:Math.floor(Date.now()/1000)+31536000});process.stdout.write(h+"."+p+"."+c.createHmac("sha256",process.env.PVMBG_JWT_SECRET).update(h+"."+p).digest("base64url"))')}" && \
	kubectl -n $(NAMESPACE) create secret generic bnpb-secrets \
		--from-literal=PVMBG_ACCESS_TOKEN="$${PVMBG_ACCESS_TOKEN}" \
		--from-literal=AUDIT_TOKEN="$${AUDIT_TOKEN}" \
		--from-literal=SAT_AUTH_TOKEN="$${SAT_AUTH_TOKEN}" \
		--from-literal=BMKG_API_KEY="$${BMKG_API_KEY}" \
		--from-literal=PVMBG_JWT_SECRET="$${PVMBG_JWT_SECRET}" \
		--from-literal=CLIENT_JWT_SECRET="$${CLIENT_JWT_SECRET}" \
		--from-literal=INTERNAL_SERVICE_KEY="$${INTERNAL_SERVICE_KEY}" \
		--from-literal=AUTH_MEDIA_CLIENT_ID="$${AUTH_MEDIA_CLIENT_ID}" \
		--from-literal=AUTH_MEDIA_CLIENT_SECRET="$${AUTH_MEDIA_CLIENT_SECRET}" \
		--from-literal=AUTH_LAPANGAN_CLIENT_ID="$${AUTH_LAPANGAN_CLIENT_ID}" \
		--from-literal=AUTH_LAPANGAN_CLIENT_SECRET="$${AUTH_LAPANGAN_CLIENT_SECRET}" \
		--from-literal=AUTH_INTERNAL_CLIENT_ID="$${AUTH_INTERNAL_CLIENT_ID}" \
		--from-literal=AUTH_INTERNAL_CLIENT_SECRET="$${AUTH_INTERNAL_CLIENT_SECRET}" \
		--from-literal=RABBITMQ_DEFAULT_USER="$${RABBITMQ_DEFAULT_USER}" \
		--from-literal=RABBITMQ_DEFAULT_PASS="$${RABBITMQ_DEFAULT_PASS}" \
		--from-literal=RABBITMQ_ERLANG_COOKIE="$${RABBITMQ_ERLANG_COOKIE}" \
		--from-literal=RABBITMQ_URL="$${RABBITMQ_URL}" \
		--dry-run=client -o yaml | kubectl apply -f - && \
	kubectl -n $(NAMESPACE) create secret generic pantai-token \
		--from-literal=token="$${PANTAI_AUTH_TOKEN}" \
		--dry-run=client -o yaml | kubectl apply -f -

build:
	docker build -t $(IMAGE_REGISTRY)/bnpb-bmkg-mock:$(IMAGE_TAG) -f services/bmkg-mock/Dockerfile .
	docker build -t $(IMAGE_REGISTRY)/bnpb-pvmbg-mock:$(IMAGE_TAG) -f services/pvmbg-mock/Dockerfile .
	docker build -t $(IMAGE_REGISTRY)/bnpb-aggregator:$(IMAGE_TAG) -f services/aggregator/Dockerfile .
	docker build -t $(IMAGE_REGISTRY)/bnpb-auth-service:$(IMAGE_TAG) -f services/auth-service/Dockerfile .
	docker build -t $(IMAGE_REGISTRY)/bnpb-client-api:$(IMAGE_TAG) -f services/client-api/Dockerfile .
	docker build -t $(IMAGE_REGISTRY)/bnpb-dashboard-updater:$(IMAGE_TAG) -f services/consumers/dashboard-updater/Dockerfile .
	docker build -t $(IMAGE_REGISTRY)/bnpb-notifier:$(IMAGE_TAG) -f services/consumers/notifier/Dockerfile .
	docker build -t $(IMAGE_REGISTRY)/bnpb-storage-unit:$(IMAGE_TAG) -f services/storage-unit/Dockerfile .
	docker build -t $(IMAGE_REGISTRY)/bnpb-satellite-processor:$(IMAGE_TAG) -f services/satellite-processor/Dockerfile .
	docker build -t $(IMAGE_REGISTRY)/bnpb-field-report-processor:$(IMAGE_TAG) -f services/field-report-processor/Dockerfile .
	docker build -t $(IMAGE_REGISTRY)/bnpb-advisor:$(IMAGE_TAG) -f services/advisor/Dockerfile .
	docker build -t $(IMAGE_REGISTRY)/bnpb-analytics-dashboard:$(IMAGE_TAG) -f services/analytics-dashboard/Dockerfile .

push:
	@for svc in $(SERVICES); do \
		docker push $(IMAGE_REGISTRY)/bnpb-$$svc:$(IMAGE_TAG); \
	done

up: secrets
	kubectl apply -k deploy/k8s/overlays/$(OVERLAY)
	kubectl -n $(NAMESPACE) rollout status statefulset/rabbitmq --timeout=180s || true
	kubectl -n $(NAMESPACE) rollout status deployment/sensor-pantai --timeout=120s || true
	kubectl -n $(NAMESPACE) rollout status deployment/aggregator --timeout=120s || true
	kubectl -n $(NAMESPACE) rollout status deployment/client-api --timeout=120s || true
	kubectl -n $(NAMESPACE) get pods -o wide

down:
	kubectl delete -k deploy/k8s/overlays/$(OVERLAY) --ignore-not-found

verify-labels:
	bash scripts/verify/verify-labels.sh

verify-resources:
	bash scripts/verify/verify-resources.sh

verify-netpol:
	bash scripts/verify/verify-netpol.sh

verify-manifests:
	bash scripts/verify/verify-labels.sh --manifest-check
	bash scripts/verify/verify-resources.sh --manifest-check
	bash scripts/verify/verify-netpol.sh --manifest-check

obs-vendor:
	@for svc in services/aggregator services/auth-service services/client-api services/bmkg-mock services/pvmbg-mock services/consumers/notifier services/consumers/dashboard-updater; do \
		mkdir -p $$svc/src/obs; \
		cp tools/obs-kit/src/*.ts $$svc/src/obs/; \
	done
	@echo "[obs-vendor] Copied tools/obs-kit/src/*.ts into all services."
