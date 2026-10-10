"""Direct matrix API: independent arithmetic, input preservation, and residency."""
import pytest
import torch

from synapse_mesh.tensor_fusion import dynamic_fusion_kernel


@pytest.mark.parametrize('tensor_alpha', [False, True])
@pytest.mark.parametrize('device,dtype', [
    ('cpu', torch.float64),
    ('cpu', torch.float32),
    pytest.param('cuda', torch.float32, marks=pytest.mark.skipif(
        not torch.cuda.is_available(), reason='CUDA unavailable')),
    pytest.param('cuda', torch.float16, marks=pytest.mark.skipif(
        not torch.cuda.is_available(), reason='CUDA unavailable')),
    pytest.param('cuda', torch.bfloat16, marks=pytest.mark.skipif(
        not torch.cuda.is_available() or not torch.cuda.is_bf16_supported(),
        reason='CUDA BF16 unavailable')),
])
def test_weighted_products_with_mixed_ranks(device, dtype, tensor_alpha):
    # Transposed factors exercise non-contiguous inputs and rectangular weights.
    base = torch.arange(15, device=device, dtype=dtype).reshape(3, 5) / 16
    pairs = [(torch.arange(rank * 3, device=device, dtype=dtype).reshape(rank, 3).T / 8,
              torch.arange(5 * rank, device=device, dtype=dtype).reshape(5, rank).T / 8)
             for rank in (1, 2, 4)]
    coefficients = [0.5, -0.25, 1.5]
    originals = [t.clone() for t in [base, *(t for pair in pairs for t in pair)]]
    expected = base.double().clone()
    for coefficient, (a, b) in zip(coefficients, pairs):
        # Independent reference with double-precision einsum.
        expected += coefficient * torch.einsum('or,ri->oi', a.double(), b.double())
    alpha = torch.tensor(coefficients, device=device, dtype=dtype) if tensor_alpha else coefficients
    fused = dynamic_fusion_kernel(base, pairs, alpha)
    tolerance = 0.02 if dtype in (torch.float16, torch.bfloat16) else 1e-6
    torch.testing.assert_close(fused.double(), expected, rtol=tolerance, atol=tolerance)
    assert fused.device == base.device and fused.dtype == base.dtype
    assert fused.data_ptr() != base.data_ptr() and not fused.requires_grad
    for actual, original in zip([base, *(t for pair in pairs for t in pair)], originals):
        assert torch.equal(actual, original)
    torch.testing.assert_close(dynamic_fusion_kernel(base, pairs, alpha), fused, rtol=0, atol=0)


def test_empty_mixture_returns_independent_base_copy():
    base = torch.ones(3, 5, requires_grad=True)
    fused = dynamic_fusion_kernel(base, [], [])
    assert torch.equal(fused, base)
    assert fused.data_ptr() != base.data_ptr() and not fused.requires_grad


def test_zero_python_coefficient_skips_product():
    base = torch.ones(3, 5)
    pair = (torch.full((3, 2), float('nan')), torch.ones(2, 5))
    assert torch.equal(dynamic_fusion_kernel(base, [pair], [0.]), base)


@pytest.mark.parametrize('alpha', [[1., 2.], [float('nan')], [float('inf')],
                                   torch.ones(1, 1), torch.tensor([float('nan')])])
def test_invalid_coefficients(alpha):
    with pytest.raises(ValueError, match='alpha'):
        dynamic_fusion_kernel(torch.zeros(3, 5), [(torch.ones(3, 2), torch.ones(2, 5))], alpha)


@pytest.mark.parametrize('pair', [
    (torch.ones(3, 2), torch.ones(4, 5)),
    (torch.ones(4, 2), torch.ones(2, 5)),
    (torch.ones(3, 2), torch.ones(2, 4)),
    (torch.ones(3, 2, dtype=torch.float64), torch.ones(2, 5)),
    (torch.ones(3, 2, device='meta'), torch.ones(2, 5)),
    (torch.ones(3), torch.ones(2, 5)),
])
def test_invalid_pair_preserves_base(pair):
    base = torch.ones(3, 5)
    with pytest.raises(ValueError, match='LoRA pair'):
        dynamic_fusion_kernel(base, [(torch.ones(3, 1), torch.ones(1, 5)), pair], [1., 1.])
    assert torch.equal(base, torch.ones_like(base))
