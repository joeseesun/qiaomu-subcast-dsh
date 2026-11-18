use anyhow::{anyhow, Result};
pub fn verify(pubkey_b64: &str, bytes: &[u8], sig_b64: &str) -> Result<()> {
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD;
    let pk = String::from_utf8(b64.decode(pubkey_b64.trim())?)?;
    let sig = String::from_utf8(b64.decode(sig_b64.trim())?)?;
    let pk = minisign_verify::PublicKey::decode(&pk).map_err(|e| anyhow!("公钥无效：{e}"))?;
    let sig = minisign_verify::Signature::decode(&sig).map_err(|e| anyhow!("签名格式无效：{e}"))?;
    pk.verify(bytes, &sig, false).map_err(|_| anyhow!("界面更新的签名不对"))
}
