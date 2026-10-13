# 认证、token 与安全验证

按证据区分：

- client_computed_token：客户端本地计算；记录输入、算法及密钥/IV的来源说明，不记录实际秘密
- server_issued_session：服务器签发；记录授权流程、access/refresh 角色、期限、刷新失败恢复
- request_signature：单次请求签名；核对其与请求参数、时间或随机数的关系
- anti_bot_check：安全验证/风控；区分请求被转向验证页与业务权限不足
- unknown：来源或机制仍未确认

用 `analysis_record_auth` 登记 evidenceIds、tokenSource、verifiedScope 和结论等级。expiresSeconds 未确认时省略，不猜测有效期；renewal 仅记录已有证据支持的方式。静态找到 AES、JWT、字段名或一段授权代码不等于已经生成有效 token。

验证范围明确到本地计算一致、授权响应、握手、订阅、取得业务数据、与页面一致中的实际一步。客户端计算出的 token 与服务器签发的 session 可以同时存在，不能当成一个算法。普通接口授权和验证码/设备验证也不互相代替。

密钥、token 值、真实会话和具体应用的业务规则留在本次私有材料中，不加入通用 Skill 或插件发布包。通用工作流不承诺每个软件都能脱离原客户端调用。
